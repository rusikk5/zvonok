'use strict';

class VoiceEngine {
  constructor() {
    this.socket           = null;
    this.myUserId         = null;
    this.roomId           = null;
    this.localStream      = null;   // processed mic stream → WebRTC
    this.localVideoStream = null;   // camera stream
    this.screenStream     = null;   // screen share stream
    this._screenCleanup   = null;   // canvas-crop teardown (track.stop won't fire 'ended')
    this.cameraEnabled    = false;
    this.peers            = new Map();  // socketId → { pc, userId }
    this.audioEls         = new Map();  // socketId → HTMLAudioElement
    this._screenSenders   = new Map();  // socketId → RTCRtpSender
    this.muted            = false;
    this.micId            = null;
    this.speakerId        = null;
    this._volCtxs         = [];
    this._micCtx          = null;
    this._workletNode     = null;
    this._rawMicStream    = null;
    this._micRestartGen   = 0;

    this.onSpeaking     = null;
    this.onUserLeft     = null;
    this.onUserJoined   = null;
    this.onCameraChange = null;
    this.onInputLevel   = null;
    this.onScreenShare      = null;  // (isSharing, stream | null)
    this.onRemoteScreen     = null;  // (userId, stream | null)
    this.onScreenShareError = null;  // (message) => void
    this.onPing             = null;  // (ms | null, quality 'good'|'mid'|'bad')
    this._pingTimer         = null;
    this._lastPing          = null;

    // Noise suppression mode: 'off' | 'standard' | 'ghoul'
    this.noiseMode        = localStorage.getItem('zvonok_noise_mode')
                            || (localStorage.getItem('zvonok_noise') === 'false' ? 'off' : 'standard');
    this.noiseThreshold   = parseInt(localStorage.getItem('zvonok_threshold') || '12', 10);
    this.autoGate         = localStorage.getItem('zvonok_autogate') !== 'false';
    this._noiseFloor      = 8;
  }

  get noiseSuppression() { return this.noiseMode !== 'off'; }

  init(socket, userId) {
    this.socket   = socket;
    this.myUserId = userId;
    this._signaling();
  }

  _signaling() {
    this.socket.on('voice:init', async (participants) => {
      for (const p of participants) await this._offer(p.socketId, p.userId);
    });

    this.socket.on('voice:joined', ({ userId }) => {
      if (this.onUserJoined) this.onUserJoined(userId);
    });

    // Perfect negotiation: handles offer/answer collisions (glare) during renegotiation
    this.socket.on('voice:offer', async ({ from, fromUser, offer }) => {
      let peer = this.peers.get(from);
      if (!peer) { this._makePeer(from, fromUser); peer = this.peers.get(from); }
      const pc = peer.pc;

      const collision = peer.makingOffer || pc.signalingState !== 'stable';
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;   // impolite peer wins, ignores incoming offer

      try {
        await pc.setRemoteDescription(offer);   // polite peer auto-rolls back on collision
        await pc.setLocalDescription();          // implicit answer
        this.socket.emit('voice:answer', { to: from, answer: pc.localDescription });
      } catch (e) { console.warn('[voice:offer]', e); }
    });

    this.socket.on('voice:answer', async ({ from, answer }) => {
      const peer = this.peers.get(from);
      if (!peer) return;
      try { await peer.pc.setRemoteDescription(answer); } catch (e) { console.warn('[voice:answer]', e); }
    });

    this.socket.on('voice:ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from);
      if (!peer || !candidate) return;
      try { await peer.pc.addIceCandidate(candidate); }
      catch (e) { if (!peer.ignoreOffer) console.warn('[voice:ice]', e); }
    });

    this.socket.on('voice:left', ({ userId, socketId }) => {
      this._cleanPeer(socketId);
      if (this.onUserLeft) this.onUserLeft(userId);
    });

    this.socket.on('screen:started', ({ userId }) => {
      // Remote screen track arrives via WebRTC ontrack — this is just for future UI use
    });
    this.socket.on('screen:stopped', ({ userId }) => {
      if (this.onRemoteScreen) this.onRemoteScreen(userId, null);
    });
  }

  async join(roomId) {
    this.roomId = roomId;
    await this._setupMic();
    this.socket.emit('voice:join', { roomId });
    this._startPingMonitor();
  }

  // Socket reconnected: re-announce to the room and rebuild peers instead of dropping the call
  async rejoin() {
    if (!this.roomId) return;
    // Old peer connections reference dead socket ids — tear them down
    this.peers.forEach((_, sid) => this._cleanPeer(sid));
    // Mic usually still alive; only re-acquire if it was lost
    if (!this.localStream) await this._setupMic();
    this.socket.emit('voice:join', { roomId: this.roomId });
    this._startPingMonitor();
  }

  // ── Ping / connection quality ─────────────────────────────
  _pingQuality(ms) {
    if (ms == null)  return 'bad';
    if (ms <= 200)   return 'good';
    if (ms <= 1000)  return 'mid';
    return 'bad';
  }

  _socketPing() {
    return new Promise((resolve) => {
      if (!this.socket?.connected) { resolve(null); return; }
      const t0 = performance.now();
      let done = false;
      const to = setTimeout(() => { if (!done) { done = true; resolve(null); } }, 4000);
      this.socket.emit('ping:check', () => {
        if (done) return;
        done = true; clearTimeout(to);
        resolve(Math.round(performance.now() - t0));
      });
    });
  }

  async _measurePing() {
    // Prefer real WebRTC round-trip to peers (that's the actual call latency)
    let rtt = null;
    for (const [, peer] of this.peers) {
      try {
        const stats = await peer.pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r.nominated || r.state === 'succeeded') && r.currentRoundTripTime != null) {
            const ms = r.currentRoundTripTime * 1000;
            if (rtt === null || ms < rtt) rtt = ms;
          }
        });
      } catch {}
    }
    if (rtt !== null) return Math.round(rtt);
    // Solo in channel (no peers) → fall back to socket round-trip to the server
    return await this._socketPing();
  }

  _startPingMonitor() {
    this._stopPingMonitor();
    const poll = async () => {
      const ms = await this._measurePing();
      this._lastPing = ms;
      if (this.onPing) this.onPing(ms, this._pingQuality(ms));
    };
    poll();
    this._pingTimer = setInterval(poll, 3000);
  }

  _stopPingMonitor() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    this._lastPing = null;
  }

  async _setupMic() {
    const gen = ++this._micRestartGen;
    let rawStream;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          autoGainControl:  true,
          noiseSuppression: this.noiseMode !== 'off',  // browser baseline NS (RNNoise layers on top)
          channelCount:     1,           // mono — RNNoise is mono, halves bandwidth
          sampleRate:       48000,       // ask device for 48k (RNNoise requires it)
          ...(this.micId ? { deviceId: { exact: this.micId } } : {}),
        },
        video: false,
      });
    } catch { return false; }

    if (gen !== this._micRestartGen) { rawStream.getTracks().forEach(t => t.stop()); return false; }

    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._micCtx)       { this._micCtx.close().catch(() => {}); this._micCtx = null; }
    if (this._rawMicStream) this._rawMicStream.getTracks().forEach(t => t.stop());
    this._rawMicStream = rawStream;

    // CRITICAL: pin context to 48 kHz — RNNoise's 480-sample frame == 10 ms only at 48 kHz.
    // Without this the context runs at the system rate (often 44.1 kHz) and RNNoise distorts.
    const ctx      = new AudioContext({ sampleRate: 48000 });
    this._micCtx   = ctx;
    const src      = ctx.createMediaStreamSource(rawStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const dest = ctx.createMediaStreamDestination();

    try {
      await ctx.audioWorklet.addModule('/js/rnnoise-processor.js');
      const wn = new AudioWorkletNode(ctx, 'rnnoise-processor');
      this._workletNode = wn;
      src.connect(wn); wn.connect(analyser); analyser.connect(dest);
      wn.port.onmessage = ({ data }) => {
        if (data.type === 'error') console.warn('[RNNoise]', data.msg);
      };
      wn.port.postMessage({ type: 'mode', value: this.noiseMode });
      fetch('/rnnoise.wasm')
        .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(buf => wn.port.postMessage({ type: 'wasm', buffer: buf }, [buf]))
        .catch(e => console.warn('[RNNoise] fetch:', e));
    } catch {
      // RNNoise worklet unavailable — browser NS already cleans; add a gentle low-rumble highpass
      this._workletNode = null;
      if (this.noiseSuppression) {
        const hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = 90; hpf.Q.value = 0.5;
        src.connect(hpf); hpf.connect(analyser); analyser.connect(dest);
      } else {
        src.connect(analyser); analyser.connect(dest);
      }
    }

    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (ctx !== this._micCtx || ctx.state === 'closed') return;
      analyser.getByteFrequencyData(buf);
      const v = buf.reduce((a, b) => a + b, 0) / buf.length;
      if (this.autoGate) {
        // Track ambient floor BOTH ways: follow quiet quickly, leak up slowly so a floor
        // stuck below the noise level un-sticks within ~1-2s (fixes the "always speaking" ring),
        // while the slow up-leak avoids cutting the indicator during long continuous speech.
        const a = v < this._noiseFloor ? 0.25 : 0.0025;
        this._noiseFloor   += (v - this._noiseFloor) * a;
        this.noiseThreshold = Math.min(60, Math.max(8, Math.round(this._noiseFloor * 1.8 + 6)));
      }
      if (this.onSpeaking)   this.onSpeaking(this.myUserId, v > this.noiseThreshold && !this.muted);
      if (this.onInputLevel) this.onInputLevel(
        Math.min(100, Math.round(v / 60 * 100)),
        Math.min(100, Math.round(this.noiseThreshold / 60 * 100))
      );
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    this.localStream = dest.stream;
    return true;
  }

  async _restartMic() {
    const ok = await this._setupMic();
    if (!ok) return;
    const newTrack = this.localStream?.getAudioTracks()[0];
    if (!newTrack) return;
    for (const [, peer] of this.peers) {
      const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (sender) await sender.replaceTrack(newTrack).catch(() => {});
    }
  }

  leave() {
    this.stopScreenShare();
    this._stopPingMonitor();
    if (this.roomId) this.socket.emit('voice:leave', { roomId: this.roomId });
    this.peers.forEach((_, sid) => this._cleanPeer(sid));
    this._volCtxs.forEach(ctx => ctx.close().catch(() => {}));
    this._volCtxs = [];
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._micCtx)       { this._micCtx.close().catch(() => {}); this._micCtx = null; }
    if (this._rawMicStream) { this._rawMicStream.getTracks().forEach(t => t.stop()); this._rawMicStream = null; }
    this.localStream = null;
    this.disableCamera();
    if (this.onSpeaking) this.onSpeaking(this.myUserId, false);
    this.roomId = null;
  }

  _offer(socketId, userId) {
    // Initiator: just create the peer; addTrack triggers onnegotiationneeded → sends offer
    this._makePeer(socketId, userId);
  }

  _makePeer(socketId, userId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
      ]
    });

    // Deterministic politeness: exactly one side is polite (compares own vs remote socket id)
    const peer = { pc, userId, polite: (this.socket.id || '') > socketId, makingOffer: false, ignoreOffer: false };
    this.peers.set(socketId, peer);

    const audio = document.createElement('audio');
    audio.autoplay = true; audio.playsInline = true;
    document.body.appendChild(audio);
    if (this.speakerId && audio.setSinkId) audio.setSinkId(this.speakerId).catch(() => {});
    this.audioEls.set(socketId, audio);

    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        // Accumulate all audio tracks (mic + system audio) into one playback stream
        if (!peer.recvAudio) peer.recvAudio = new MediaStream();
        peer.recvAudio.addTrack(e.track);
        audio.srcObject = peer.recvAudio;
        audio.play().catch(() => {});
        e.track.addEventListener('ended', () => {
          try { peer.recvAudio.removeTrack(e.track); } catch {}
        });
        // Only the first (mic) track drives the speaking indicator — not screen system audio
        if (!peer.micWatched) {
          peer.micWatched = true;
          this._watchVolume(new MediaStream([e.track]), (v) => {
            if (this.onSpeaking) this.onSpeaking(userId, v > this.noiseThreshold);
          });
        }
      } else if (e.track.kind === 'video') {
        const stream = e.streams[0] || new MediaStream([e.track]);
        if (this.onRemoteScreen) this.onRemoteScreen(userId, stream);
        e.track.addEventListener('ended', () => {
          if (this.onRemoteScreen) this.onRemoteScreen(userId, null);
        });
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('voice:ice', { to: socketId, candidate });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();   // implicit offer
        this.socket.emit('voice:offer', { to: socketId, offer: pc.localDescription });
      } catch (e) { console.warn('[negotiationneeded]', e); }
      finally { peer.makingOffer = false; }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch {} }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        this._cleanPeer(socketId);
        if (this.onUserLeft) this.onUserLeft(userId);
      }
    };

    // Add local tracks LAST so handlers (incl. onnegotiationneeded) are wired first
    if (this.localStream)
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    else
      // No mic (denied/absent): still negotiate so we can hear others & receive screen share
      pc.addTransceiver('audio', { direction: 'recvonly' });
    if (this.localVideoStream)
      this.localVideoStream.getTracks().forEach(t => pc.addTrack(t, this.localVideoStream));
    if (this.screenStream) {
      const senders = this.screenStream.getTracks().map(t => pc.addTrack(t, this.screenStream));
      this._screenSenders.set(socketId, senders);
    }

    return pc;
  }

  _cleanPeer(socketId) {
    const peer = this.peers.get(socketId);
    if (peer) { peer.pc.close(); this.peers.delete(socketId); }
    const audio = this.audioEls.get(socketId);
    if (audio) { audio.srcObject = null; audio.remove(); this.audioEls.delete(socketId); }
    this._screenSenders.delete(socketId);
  }

  _watchVolume(stream, callback) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._volCtxs.push(ctx);
      const src = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser();
      analyser.fftSize = 256; src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (ctx.state === 'closed') return;
        analyser.getByteFrequencyData(buf);
        callback(buf.reduce((a, b) => a + b, 0) / buf.length);
        requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  }

  setMuted(muted) {
    this.muted = muted;
    if (this._rawMicStream) this._rawMicStream.getAudioTracks().forEach(t => t.enabled = !muted);
    if (this.roomId) this.socket.emit('voice:mute', { roomId: this.roomId, muted });
    if (this.onSpeaking) this.onSpeaking(this.myUserId, false);
  }

  async enableCamera() {
    this.localVideoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    this.cameraEnabled = true;
    for (const [, peer] of this.peers) {
      for (const track of this.localVideoStream.getVideoTracks()) {
        try { peer.pc.addTrack(track, this.localVideoStream); } catch {}
      }
    }
    if (this.onCameraChange) this.onCameraChange(true, this.localVideoStream);
  }

  disableCamera() {
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(t => t.stop());
      this.localVideoStream = null;
    }
    this.cameraEnabled = false;
    if (this.onCameraChange) this.onCameraChange(false, null);
  }

  // ── Screen share ──────────────────────────────────────────
  async startScreenShare({ width, height, fps, audio, sourceId, direct, bounds, allBounds }) {
    if (this.screenStream) return;

    try {
      if (direct && sourceId) {
        // Preferred: getDisplayMedia so we can hide the OS cursor that games like CS park
        // in the centre of the screen. Main process hands back our pre-selected source.
        let got = false;
        if (window.electronAPI?.selectScreen && navigator.mediaDevices.getDisplayMedia) {
          try {
            await window.electronAPI.selectScreen(sourceId);
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
              video: {
                frameRate: { ideal: fps },
                width:  { ideal: width },
                height: { ideal: height },
                cursor: 'never',
              },
              audio: !!audio,
            });
            got = true;
          } catch { got = false; }
        }
        if (!got) {
          // Fallback: legacy getUserMedia (cursor always visible, but reliable)
          const video = { mandatory: {
            chromeMediaSource:   'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: width, maxHeight: height, maxFrameRate: fps,
          } };
          const audioOpt = audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false;
          try {
            this.screenStream = await navigator.mediaDevices.getUserMedia({ video, audio: audioOpt });
          } catch {
            this.screenStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
          }
        }
      } else if (bounds && allBounds) {
        // Fallback: full desktop capture cropped to the chosen monitor via canvas
        this.screenStream = await this._captureDisplayRegion({ width, height, fps, bounds, allBounds, audio });
      } else {
        // Fallback: entire desktop (capture system audio in the SAME call — required on Windows)
        const video = { mandatory: { chromeMediaSource: 'desktop', maxWidth: width, maxHeight: height, maxFrameRate: fps } };
        const audioOpt = audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false;
        try {
          this.screenStream = await navigator.mediaDevices.getUserMedia({ video, audio: audioOpt });
        } catch {
          this.screenStream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        }
      }
    } catch(e) {
      if (this.onScreenShareError) this.onScreenShareError(e.message || String(e));
      return;
    }

    const vTrack = this.screenStream.getVideoTracks()[0];
    if (!vTrack) {
      this.screenStream.getTracks().forEach(t => t.stop());
      if (this._screenCleanup) { this._screenCleanup(); this._screenCleanup = null; }
      this.screenStream = null;
      if (this.onScreenShareError) this.onScreenShareError('Не удалось получить видеопоток экрана');
      return;
    }
    const shareTracks = [vTrack, ...this.screenStream.getAudioTracks()];

    // Add to all existing peers — onnegotiationneeded fires automatically
    for (const [sid, peer] of this.peers) {
      const senders = shareTracks.map(t => peer.pc.addTrack(t, this.screenStream));
      this._screenSenders.set(sid, senders);
    }

    if (this.roomId) this.socket.emit('screen:start', { roomId: this.roomId });
    vTrack.addEventListener('ended', () => this.stopScreenShare());
    if (this.onScreenShare) this.onScreenShare(true, this.screenStream);
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach(t => t.stop());
    if (this._screenCleanup) { this._screenCleanup(); this._screenCleanup = null; }
    this.screenStream = null;

    for (const [sid, senders] of this._screenSenders) {
      const peer = this.peers.get(sid);
      if (peer) (Array.isArray(senders) ? senders : [senders]).forEach(s => {
        try { peer.pc.removeTrack(s); } catch {}
      });
    }
    this._screenSenders.clear();

    if (this.roomId) this.socket.emit('screen:stop', { roomId: this.roomId });
    if (this.onScreenShare) this.onScreenShare(false, null);
  }

  async _captureDisplayRegion({ width, height, fps, bounds, allBounds, audio }) {
    const video0 = { mandatory: { chromeMediaSource: 'desktop', maxWidth: 3840, maxHeight: 2160, maxFrameRate: fps } };
    let fullStream;
    try {
      fullStream = await navigator.mediaDevices.getUserMedia({
        video: video0,
        audio: audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      });
    } catch {
      fullStream = await navigator.mediaDevices.getUserMedia({ video: video0, audio: false });
    }

    const minX   = Math.min(...allBounds.map(b => b.x));
    const minY   = Math.min(...allBounds.map(b => b.y));
    const totalW = Math.max(...allBounds.map(b => b.x + b.width))  - minX;
    const totalH = Math.max(...allBounds.map(b => b.y + b.height)) - minY;

    const video = document.createElement('video');
    video.srcObject = fullStream;
    video.muted = true;
    await new Promise(r => { video.onloadedmetadata = r; video.play().catch(() => {}); });

    const canvas = document.createElement('canvas');
    canvas.width  = Math.min(width,  bounds.width);
    canvas.height = Math.min(height, bounds.height);
    const ctx = canvas.getContext('2d');

    let raf;
    const draw = () => {
      const sx = video.videoWidth  / totalW;
      const sy = video.videoHeight / totalH;
      ctx.drawImage(video,
        (bounds.x - minX) * sx, (bounds.y - minY) * sy,
        bounds.width * sx,      bounds.height * sy,
        0, 0, canvas.width, canvas.height,
      );
      raf = requestAnimationFrame(draw);
    };
    draw();

    const cropped = canvas.captureStream(fps);
    // Carry the captured system-audio track over to the outgoing (cropped) stream
    fullStream.getAudioTracks().forEach(t => cropped.addTrack(t));
    // track.stop() does NOT fire 'ended', so stopScreenShare() must call this explicitly
    this._screenCleanup = () => {
      cancelAnimationFrame(raf);
      fullStream.getTracks().forEach(t => t.stop());
      video.srcObject = null;
    };
    return cropped;
  }

  async setNoiseMode(mode) {
    this.noiseMode = mode;   // 'off' | 'standard' | 'ghoul'
    localStorage.setItem('zvonok_noise_mode', mode);
    // Switch the RNNoise/ghoul layer live
    if (this._workletNode) this._workletNode.port.postMessage({ type: 'mode', value: mode });
    // Toggle the browser's built-in NS on the raw mic track (no mic restart needed)
    const micTrack = this._rawMicStream?.getAudioTracks()[0];
    if (micTrack?.applyConstraints) {
      try { await micTrack.applyConstraints({ echoCancellation: true, autoGainControl: true, noiseSuppression: mode !== 'off' }); } catch {}
    }
    if (!this._workletNode && this.roomId) await this._restartMic();
  }

  // Back-compat for older callers
  async setNoiseSuppression(enabled) { await this.setNoiseMode(enabled ? 'standard' : 'off'); }

  setSensitivity(threshold) {
    this.noiseThreshold = threshold;
    this._noiseFloor    = Math.max(0, (threshold - 6) / 1.8);
    localStorage.setItem('zvonok_threshold', threshold);
  }

  setAutoGate(enabled) {
    this.autoGate = enabled;
    localStorage.setItem('zvonok_autogate', enabled);
    this._noiseFloor = Math.max(0, (this.noiseThreshold - 6) / 1.8);
    if (this.onSpeaking) this.onSpeaking(this.myUserId, false);  // reset indicator on mode switch
  }

  async changeMic(deviceId) {
    this.micId = deviceId;
    if (this.roomId) await this._restartMic();
  }

  async changeSpeaker(deviceId) {
    this.speakerId = deviceId;
    for (const audio of this.audioEls.values()) {
      if (audio.setSinkId) audio.setSinkId(deviceId).catch(() => {});
    }
  }

  static async getDevices() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      if (s) s.getTracks().forEach(t => t.stop());
      const all = await navigator.mediaDevices.enumerateDevices();
      return {
        mics:     all.filter(d => d.kind === 'audioinput'),
        speakers: all.filter(d => d.kind === 'audiooutput'),
      };
    } catch { return { mics: [], speakers: [] }; }
  }
}

window.VoiceEngine = VoiceEngine;

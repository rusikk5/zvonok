'use strict';

class VoiceEngine {
  constructor() {
    this.socket           = null;
    this.myUserId         = null;
    this.roomId           = null;
    this.localStream      = null;   // processed stream → WebRTC
    this.localVideoStream = null;
    this.cameraEnabled    = false;
    this.peers            = new Map();
    this.audioEls         = new Map();
    this.muted            = false;
    this.micId            = null;
    this.speakerId        = null;
    this._volCtxs         = [];     // remote-peer volume AudioContexts only
    this._micCtx          = null;   // local mic processing AudioContext
    this._workletNode     = null;   // RNNoise AudioWorkletNode
    this._rawMicStream    = null;   // raw getUserMedia stream
    this._micRestartGen   = 0;      // race-condition guard

    this.onSpeaking     = null;
    this.onUserLeft     = null;
    this.onUserJoined   = null;
    this.onCameraChange = null;
    this.onInputLevel   = null;

    this.noiseSuppression = localStorage.getItem('zvonok_noise')    !== 'false';
    this.noiseThreshold   = parseInt(localStorage.getItem('zvonok_threshold') || '12', 10);
    this.autoGate         = localStorage.getItem('zvonok_autogate') !== 'false';
    this._noiseFloor      = 8;
  }

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
    this.socket.on('voice:offer', async ({ from, fromUser, offer }) => {
      if (this.peers.has(from)) { this.peers.get(from).pc.close(); this._cleanPeer(from); }
      const pc = this._makePeer(from, fromUser);
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('voice:answer', { to: from, answer });
    });
    this.socket.on('voice:answer', async ({ from, answer }) => {
      const peer = this.peers.get(from);
      if (peer && peer.pc.signalingState === 'have-local-offer')
        await peer.pc.setRemoteDescription(answer).catch(() => {});
    });
    this.socket.on('voice:ice', async ({ from, candidate }) => {
      const peer = this.peers.get(from);
      if (peer && candidate) await peer.pc.addIceCandidate(candidate).catch(() => {});
    });
    this.socket.on('voice:left', ({ userId, socketId }) => {
      this._cleanPeer(socketId);
      if (this.onUserLeft) this.onUserLeft(userId);
    });
  }

  async join(roomId) {
    this.roomId = roomId;
    await this._setupMic();
    this.socket.emit('voice:join', { roomId });
  }

  // Returns false if superseded by a newer call
  async _setupMic() {
    const gen = ++this._micRestartGen;

    let rawStream;
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation:  true,
          autoGainControl:   true,
          noiseSuppression:  false, // handled by RNNoise worklet
          ...(this.micId ? { deviceId: { exact: this.micId } } : {}),
        },
        video: false,
      });
    } catch { return false; }

    if (gen !== this._micRestartGen) { rawStream.getTracks().forEach(t => t.stop()); return false; }

    // Tear down previous mic infrastructure
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._micCtx)       { this._micCtx.close().catch(() => {}); this._micCtx = null; }
    if (this._rawMicStream) this._rawMicStream.getTracks().forEach(t => t.stop());
    this._rawMicStream = rawStream;

    const ctx      = new AudioContext();
    this._micCtx   = ctx;
    const src      = ctx.createMediaStreamSource(rawStream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const dest = ctx.createMediaStreamDestination();

    // --- Try to load RNNoise AudioWorklet ---
    let usedWorklet = false;
    try {
      await ctx.audioWorklet.addModule('/js/rnnoise-processor.js');
      const wn = new AudioWorkletNode(ctx, 'rnnoise-processor');
      this._workletNode = wn;

      // Chain: src → rnnoiseWorklet → analyser → dest
      src.connect(wn);
      wn.connect(analyser);
      analyser.connect(dest);

      wn.port.onmessage = ({ data }) => {
        if (data.type === 'error') console.warn('[RNNoise] WASM error:', data.msg);
      };
      // Send enabled state immediately, then WASM binary
      wn.port.postMessage({ type: 'enabled', value: this.noiseSuppression });
      fetch('/rnnoise.wasm')
        .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(buf => wn.port.postMessage({ type: 'wasm', buffer: buf }, [buf]))
        .catch(e => console.warn('[RNNoise] fetch failed:', e));

      usedWorklet = true;
    } catch {
      // Worklet unavailable — fall back to Web Audio filter chain
      this._workletNode = null;
      if (this.noiseSuppression) {
        const hpf = ctx.createBiquadFilter();
        hpf.type = 'highpass'; hpf.frequency.value = 80; hpf.Q.value = 0.7;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -28; comp.knee.value = 8;
        comp.ratio.value = 8; comp.attack.value = 0.002; comp.release.value = 0.15;
        src.connect(analyser); analyser.connect(hpf); hpf.connect(comp); comp.connect(dest);
      } else {
        src.connect(analyser); analyser.connect(dest);
      }
    }

    // Volume monitoring (runs as long as this context is active)
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (ctx !== this._micCtx || ctx.state === 'closed') return;
      analyser.getByteFrequencyData(buf);
      const v = buf.reduce((a, b) => a + b, 0) / buf.length;
      if (this.autoGate && v < this.noiseThreshold) {
        this._noiseFloor    = this._noiseFloor * 0.97 + v * 0.03;
        this.noiseThreshold = Math.max(5, Math.round(this._noiseFloor * 2.8));
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

  // Hot-swap mic track in all existing peer connections
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

  async _offer(socketId, userId) {
    const pc    = this._makePeer(socketId, userId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.socket.emit('voice:offer', { to: socketId, offer });
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

    if (this.localStream)
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    if (this.localVideoStream)
      this.localVideoStream.getTracks().forEach(t => pc.addTrack(t, this.localVideoStream));

    const audio = document.createElement('audio');
    audio.autoplay = true; audio.playsInline = true;
    document.body.appendChild(audio);
    if (this.speakerId && audio.setSinkId) audio.setSinkId(this.speakerId).catch(() => {});
    this.audioEls.set(socketId, audio);

    pc.ontrack = (e) => {
      if (e.track.kind !== 'audio') return;
      const stream = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      this._watchVolume(stream, (v) => {
        if (this.onSpeaking) this.onSpeaking(userId, v > this.noiseThreshold);
      });
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('voice:ice', { to: socketId, candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        this._cleanPeer(socketId);
        if (this.onUserLeft) this.onUserLeft(userId);
      }
    };

    this.peers.set(socketId, { pc, userId });
    return pc;
  }

  _cleanPeer(socketId) {
    const peer = this.peers.get(socketId);
    if (peer) { peer.pc.close(); this.peers.delete(socketId); }
    const audio = this.audioEls.get(socketId);
    if (audio) { audio.srcObject = null; audio.remove(); this.audioEls.delete(socketId); }
  }

  // Used only for remote peer speaking indicators
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

  async setNoiseSuppression(enabled) {
    this.noiseSuppression = enabled;
    localStorage.setItem('zvonok_noise', enabled);
    if (this._workletNode) {
      // Instant toggle — no mic restart, no disconnection
      this._workletNode.port.postMessage({ type: 'enabled', value: enabled });
    } else if (this.roomId) {
      // Fallback: rebuild filter chain
      await this._restartMic();
    }
  }

  setSensitivity(threshold) {
    this.noiseThreshold = threshold;
    this._noiseFloor    = threshold / 2.8;
    localStorage.setItem('zvonok_threshold', threshold);
  }

  setAutoGate(enabled) {
    this.autoGate = enabled;
    localStorage.setItem('zvonok_autogate', enabled);
    if (enabled) this._noiseFloor = this.noiseThreshold / 2.8;
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

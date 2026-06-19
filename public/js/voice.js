'use strict';

class VoiceEngine {
  constructor() {
    this.socket          = null;
    this.myUserId        = null;
    this.roomId          = null;
    this.localStream     = null;
    this.localVideoStream = null;
    this.cameraEnabled   = false;
    this.peers           = new Map();   // socketId -> { pc, userId }
    this.audioEls        = new Map();   // socketId -> HTMLAudioElement
    this.muted           = false;
    this.micId           = null;
    this.speakerId       = null;
    this._volCtxs        = [];

    this.onSpeaking   = null;
    this.onUserLeft   = null;
    this.onUserJoined = null;
    this.onCameraChange = null;
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
      if (peer && peer.pc.signalingState === 'have-local-offer') {
        await peer.pc.setRemoteDescription(answer).catch(() => {});
      }
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
    const constraints = {
      audio: this.micId ? { deviceId: { exact: this.micId } } : true,
      video: false,
    };
    this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    this._watchVolume(this.localStream, (v) => {
      if (this.onSpeaking) this.onSpeaking(this.myUserId, v > 10 && !this.muted);
    });
    this.socket.emit('voice:join', { roomId });
  }

  leave() {
    if (this.roomId) this.socket.emit('voice:leave', { roomId: this.roomId });
    this.peers.forEach((_, sid) => this._cleanPeer(sid));
    this._volCtxs.forEach(ctx => ctx.close().catch(() => {}));
    this._volCtxs = [];
    if (this.localStream) { this.localStream.getTracks().forEach(t => t.stop()); this.localStream = null; }
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
    const pc = new RTCPeerConnection({ iceServers: [] });

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => pc.addTrack(t, this.localStream));
    }
    if (this.localVideoStream) {
      this.localVideoStream.getTracks().forEach(t => pc.addTrack(t, this.localVideoStream));
    }

    const audio = document.createElement('audio');
    audio.autoplay = true; audio.playsInline = true;
    document.body.appendChild(audio);
    if (this.speakerId && audio.setSinkId) audio.setSinkId(this.speakerId).catch(() => {});
    this.audioEls.set(socketId, audio);

    pc.ontrack = (e) => {
      if (!e.streams[0]) return;
      if (e.track.kind === 'audio') {
        audio.srcObject = e.streams[0];
        this._watchVolume(e.streams[0], (v) => {
          if (this.onSpeaking) this.onSpeaking(userId, v > 10);
        });
      }
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

  _watchVolume(stream, callback) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._volCtxs.push(ctx);
      const src = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser();
      analyser.fftSize = 256; src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      let active = true;
      const tick = () => {
        if (!active || ctx.state === 'closed') return;
        analyser.getByteFrequencyData(buf);
        callback(buf.reduce((a,b) => a+b, 0) / buf.length);
        requestAnimationFrame(tick);
      };
      tick();
      ctx._stop = () => { active = false; };
    } catch {}
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.localStream) this.localStream.getAudioTracks().forEach(t => t.enabled = !muted);
    if (this.roomId) this.socket.emit('voice:mute', { roomId: this.roomId, muted });
    if (this.onSpeaking) this.onSpeaking(this.myUserId, false);
  }

  async enableCamera() {
    this.localVideoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    this.cameraEnabled = true;
    // Add video tracks to all existing peers
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

  async changeMic(deviceId) {
    this.micId = deviceId;
    if (this.roomId) { const r = this.roomId; this.leave(); await this.join(r); }
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
      return { mics: all.filter(d => d.kind === 'audioinput'), speakers: all.filter(d => d.kind === 'audiooutput') };
    } catch { return { mics: [], speakers: [] }; }
  }
}

window.VoiceEngine = VoiceEngine;

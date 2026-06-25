'use strict';

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════
const S = {
  token:   localStorage.getItem('zvonok_token'),
  me:      null,
  socket:  null,
  voice:   new VoiceEngine(),

  rooms:      [],
  roomId:     null,
  room:       null,
  members:    [],
  messages:   [],

  voiceUsers: new Map(),
  voiceRoom:  [],

  friends: [],
  pending: [],
  online:  new Set(),

  muted:       false,
  view:        'empty',  // 'empty' | 'chat' | 'friends' | 'dm'
  showMembers: true,
  dmWith:      null,     // { id, name, username, avatar, name_color }
  dmMessages:  [],

  ringFrom:    null,     // incoming DM call info
  dmCallWith:  null,     // user we're currently in DM call with
  dmCallState: null,     // 'calling' | 'connected'
  dmCallTimeout: null,
  screenSharing: false,
  myStatus:    localStorage.getItem('zvonok_status') || 'online',
  statuses:    new Map(), // userId -> 'online'|'dnd'  (invisible = offline)
  dmConvos:    [],        // recent DM conversations
};

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
async function api(url, opts = {}) {
  const res  = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${S.token}`,
      ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const $ = id => document.getElementById(id);

function toast(msg, type = '') {
  const el  = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

const COLORS = ['#1a3a6a','#3a1a6a','#1a5a3a','#5a3a1a','#2a1a4a','#1a4a2a','#4a1a2a','#1a2a4a'];
function strColor(s) {
  let h = 0;
  for (const c of (s || 'x')) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return COLORS[Math.abs(h) % COLORS.length];
}

const NAME_PALETTE = [
  '#f4a933','#e85d75','#5b9cf6','#56d364','#c47fda',
  '#4ec9b0','#f08a5d','#6bcfef','#e4a9f3','#7dd87a',
];
function nameColor(user) {
  if (user && user.name_color) return user.name_color;
  const username = typeof user === 'string' ? user : (user?.username || 'x');
  let h = 0;
  for (const c of username) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return NAME_PALETTE[Math.abs(h) % NAME_PALETTE.length];
}

function _avaErr(el, bg, fs, letter) {
  const d = document.createElement('div');
  d.className = 'def-ava';
  d.style.cssText = 'background:' + bg + ';font-size:' + fs + 'px';
  d.textContent = letter;
  el.replaceWith(d);
}
function avatarHTML(user, size = 36) {
  const name   = user.name || user.username || '?';
  const letter = name.charAt(0).toUpperCase();
  const fs     = Math.floor(size / 3);
  const bg     = strColor(user.username || user.id);
  if (user.avatar && user.avatar !== 'default') {
    const src = user.avatar + (user.avatar.startsWith('/uploads/') ? '?v=' + Date.now() : '');
    return `<img src="${src}" alt="${letter}" style="width:100%;height:100%;object-fit:cover;border-radius:50%" onerror="_avaErr(this,'${bg}',${fs},'${letter}')">`;
  }
  return `<div class="def-ava" style="background:${bg};font-size:${fs}px">${letter}</div>`;
}

function onlineDot(userId) {
  if (!S.online.has(userId)) return 'dot-offline';
  return S.statuses.get(userId) === 'dnd' ? 'dot-dnd' : 'dot-online';
}

function statusLabel(userId) {
  if (!S.online.has(userId)) return 'Не в сети';
  return S.statuses.get(userId) === 'dnd' ? 'Не беспокоить' : 'В сети';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}
function formatDate(ts) {
  return new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

// ── Voice sounds ──────────────────────────────────────────────
// One shared, persistently-unlocked AudioContext. Socket-driven sounds (join/leave/notify)
// fire WITHOUT a user gesture, so a fresh AudioContext would start 'suspended' and stay silent.
// We keep one context and resume it on the first user interaction.
let _sndCtx = null;
const _audioBufs = {};
function _getSndCtx() {
  if (!_sndCtx) {
    try { _sndCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (_sndCtx.state === 'suspended') _sndCtx.resume().catch(() => {});
  return _sndCtx;
}
// Unlock audio on any interaction: the shared sound context AND the live mic context
// (if it started suspended, the mic graph would output silence to peers).
['pointerdown', 'keydown'].forEach(ev =>
  window.addEventListener(ev, () => {
    _getSndCtx();
    const mc = S.voice?._micCtx;
    if (mc && mc.state === 'suspended') mc.resume().catch(() => {});
  }, { once: false, passive: true }));

async function _loadSnd(name) {
  if (_audioBufs[name]) return _audioBufs[name];
  const ctx = _getSndCtx();
  if (!ctx) throw new Error('no audio ctx');
  const r   = await fetch(`/sounds/${name}.wav`);
  const buf = await r.arrayBuffer();
  _audioBufs[name] = await ctx.decodeAudioData(buf);
  return _audioBufs[name];
}
function _playSnd(name, vol = 0.35) {
  _loadSnd(name).then(buf => {
    const ctx = _getSndCtx();
    if (!ctx) return;
    const src  = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  }).catch(() => {});
}
function playJoinSound()  { _playSnd('join');  }
function playLeaveSound() { _playSnd('leave'); }

// Short synthesized notification "ding" for incoming messages (no asset needed)
let _lastNotif = 0;
function playNotifSound() {
  const now = Date.now();
  if (now - _lastNotif < 800) return;   // throttle bursts
  _lastNotif = now;
  const ctx = _getSndCtx();
  if (!ctx) return;
  try {
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
    [ [880, 0], [1320, 0.09] ].forEach(([f, dt]) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t + dt);
      o.connect(g);
      o.start(t + dt);
      o.stop(t + 0.45);
    });
  } catch {}
}

function playRingSound() {
  try {
    const ctx  = new AudioContext();
    let t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.start(t);
      osc.stop(t + 0.15);
      t += 0.25;
    }
    setTimeout(() => ctx.close(), 1000);
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════
async function init() {
  // Enable translucent (glass) styling only where the OS provides real blur (Win11/macOS)
  if (window.electronAPI?.translucent) document.querySelector('.window')?.classList.add('translucent');
  if (!S.token) return (location.href = '/');
  try {
    S.me = await api('/api/me');
  } catch {
    localStorage.removeItem('zvonok_token');
    return (location.href = '/');
  }
  renderUserBar();
  setupSocket();
  setupUI();
  await Promise.all([loadRooms(), loadFriends()]);
  if (S.rooms.length > 0) selectRoom(S.rooms[0].id);
}

// ═══════════════════════════════════════════════════════════════
// Socket
// ═══════════════════════════════════════════════════════════════
function setupSocket() {
  S.socket = io({ auth: { token: S.token } });
  S.voice.init(S.socket, S.me.id);
  S.voice.onSpeaking   = onSpeaking;
  S.voice.onUserLeft   = onVoiceLeft;
  S.voice.onPing       = updateVoicePing;
  S.voice.onUserJoined = (uid) => {
    const isNew = !S.voiceUsers.has(uid);
    if (isNew) S.voiceUsers.set(uid, { muted: false, speaking: false });
    if (isNew && !S.dmCallState && S.voice.roomId) playJoinSound();
    renderVoiceCard();
    renderMembers();
  };

  S.socket.on('connect', () => {
    if (S.myStatus !== 'online') S.socket.emit('set:status', S.myStatus);
    // Socket reconnected — server dropped us from the voice room; rejoin instead of leaving
    if (S.voice.roomId) S.voice.rejoin();
  });

  S.socket.on('connect_error', (e) => {
    if (e.message === 'auth') { localStorage.removeItem('zvonok_token'); location.href = '/'; }
  });

  S.socket.on('status:ack', (status) => {
    S.myStatus = status;
    localStorage.setItem('zvonok_status', status);
    renderUserBar();
  });

  S.socket.on('user:status', ({ userId, status }) => {
    if (status === 'dnd') S.statuses.set(userId, 'dnd');
    else S.statuses.delete(userId);
    renderMembers();
    renderFriends();
  });

  S.socket.on('presence', ({ userId, online }) => {
    if (online) S.online.add(userId); else { S.online.delete(userId); S.statuses.delete(userId); }
    renderMembers();
    renderFriends();
  });

  S.socket.on('user:update', ({ id, name, avatar, name_color }) => {
    if (id === S.me.id) {
      if (name)   S.me.name   = name;
      if (avatar) S.me.avatar = avatar;
      if (name_color !== undefined) S.me.name_color = name_color;
      renderUserBar();
    }
    // Update local caches
    S.members  = S.members.map(m  => m.id === id  ? { ...m, name: name || m.name, avatar: avatar || m.avatar, name_color: name_color !== undefined ? name_color : m.name_color } : m);
    S.friends  = S.friends.map(f  => f.id === id  ? { ...f, name: name || f.name, avatar: avatar || f.avatar, name_color: name_color !== undefined ? name_color : f.name_color } : f);
    renderMembers();
    renderFriends();
  });

  S.socket.on('msg', (msg) => {
    if ((msg.user_id || msg.from_id) !== S.me.id) playNotifSound();
    if (msg.room_id !== S.roomId) return;
    S.messages.push(msg);
    appendMessage(msg, $('messages'));
    scrollEl($('messages'));
  });

  S.socket.on('voice:state', ({ roomId, users, startedAt }) => {
    // Accept for the room we're viewing OR the room we're in voice
    if (roomId !== S.roomId && roomId !== S.voice.roomId) return;
    // Shared channel timer: everyone counts from when the FIRST participant joined
    if (typeof startedAt === 'number') {
      S.voiceStartedAt = startedAt;
      if (_vcTimerRunning) _vcStartTime = startedAt;
    }
    S.voiceRoom = users;
    for (const uid of S.voiceUsers.keys()) {
      if (!users.includes(uid)) {
        S.voiceUsers.delete(uid);
        // Leave sound is handled by voice.onUserLeft when you're in the same channel
      }
    }
    users.forEach(uid => {
      if (!S.voiceUsers.has(uid)) S.voiceUsers.set(uid, { muted: false, speaking: false });
    });
    const cnt = users.length;
    $('vch-cnt').textContent = cnt > 0 ? `${cnt}` : '';
    renderVoiceCard();
    renderMembers();
  });

  S.socket.on('voice:mute', ({ userId, muted }) => {
    if (S.voiceUsers.has(userId)) S.voiceUsers.get(userId).muted = muted;
    renderVoiceCard();
    renderMembers();
  });

  S.socket.on('room:joined', async ({ roomId, user }) => {
    if (roomId === S.roomId) { S.members.push(user); renderMembers(); }
  });
  S.socket.on('room:left', ({ roomId, userId }) => {
    if (roomId === S.roomId) { S.members = S.members.filter(m => m.id !== userId); renderMembers(); }
  });

  S.socket.on('sys:msg', ({ roomId, text }) => {
    if (roomId !== S.roomId) return;
    const el = document.createElement('div');
    el.className = 'sys-msg';
    el.textContent = text;
    $('messages').appendChild(el);
    scrollEl($('messages'));
  });

  S.socket.on('friend:request', (user) => {
    S.pending.push(user);
    renderFriends();
    toast(`${user.name} хочет добавить тебя в друзья`);
  });
  S.socket.on('friend:accepted', (user) => {
    S.friends.push(user);
    renderFriends();
    toast(`${user.name} принял заявку в друзья`, 'success');
  });

  // DM
  S.socket.on('dm:msg', (msg) => {
    if (msg.from_id !== S.me.id) playNotifSound();
    S.dmMessages.push(msg);
    // Update DM convos list (refresh last_msg)
    const otherId = msg.from_id === S.me.id ? msg.to_id : msg.from_id;
    const existing = S.dmConvos.find(c => c.id === otherId);
    if (existing) {
      existing.last_msg = msg.content;
      S.dmConvos = [existing, ...S.dmConvos.filter(c => c.id !== otherId)];
    }
    if (S.view === 'dm' && S.dmWith?.id === otherId) {
      appendMessage(msg, $('dm-messages'));
      scrollEl($('dm-messages'));
    } else if (msg.from_id !== S.me.id) {
      const sender = S.friends.find(f => f.id === msg.from_id);
      toast(`💬 ${sender?.name || 'Сообщение'}: ${msg.content.slice(0, 40)}`);
    }
    if (S.view === 'friends') renderFriends();
  });

  S.socket.on('dm:ring', ({ from }) => {
    if (S.myStatus === 'dnd') return;
    S.ringFrom = from;
    playRingSound();
    $('ring-ava').innerHTML = `<div style="width:60px;height:60px;border-radius:50%;overflow:hidden">${avatarHTML(from, 60)}</div>`;
    $('ring-name').textContent = from.name || from.username;
    $('call-ring').classList.remove('hidden');
  });

  S.socket.on('dm:ring:cancelled', () => {
    $('call-ring').classList.add('hidden');
    S.ringFrom = null;
  });

  S.socket.on('dm:ring:accepted', ({ from }) => {
    clearTimeout(S.dmCallTimeout);
    joinDMVoice(from);
  });

  S.socket.on('dm:ring:declined', ({ from }) => {
    clearTimeout(S.dmCallTimeout);
    $('dm-call-ov').classList.add('hidden');
    S.dmCallWith = null;
    S.dmCallState = null;
    toast(`${from.name || from.username} отклонил звонок`);
  });

  S.socket.on('dm:call:ended', ({ fromId }) => {
    if (S.dmCallWith && S.dmCallWith.id === fromId) {
      endDMCall(false);
      toast('Звонок завершён');
    }
  });
}

function updateVoicePing(ms, quality) {
  const panel = $('voice-status');
  if (!panel) return;
  panel.classList.remove('q-good', 'q-mid', 'q-bad');
  panel.classList.add('q-' + (quality || 'bad'));
  const label = (ms == null) ? '—' : ms + ' мс';
  panel.title = 'Пинг: ' + label;
  const pingEl = $('vs-ping');
  if (pingEl) pingEl.textContent = (ms == null) ? '' : '  ·  ' + ms + ' мс';
}

function onSpeaking(userId, speaking) {
  if (!S.voiceUsers.has(userId)) S.voiceUsers.set(userId, { muted: false, speaking: false });
  S.voiceUsers.get(userId).speaking = speaking;
  document.querySelectorAll(`.vp-item[data-uid="${userId}"], .member[data-uid="${userId}"], .vuser[data-uid="${userId}"]`).forEach(el => {
    el.classList.toggle('speaking', speaking);
  });
  // Update DM call overlay speaking rings
  if (S.dmCallState === 'connected') {
    if (userId === S.me.id) {
      $('dmc-me')?.classList.toggle('speaking', speaking);
    } else if (S.dmCallWith && userId === S.dmCallWith.id) {
      $('dmc-them')?.classList.toggle('speaking', speaking);
    }
  }
}

function onVoiceLeft(userId) {
  if (!S.dmCallState && S.voice.roomId) playLeaveSound();
  S.voiceUsers.delete(userId);
  renderVoiceCard();
  renderMembers();
}

// ═══════════════════════════════════════════════════════════════
// Rooms
// ═══════════════════════════════════════════════════════════════
async function loadRooms() {
  S.rooms = await api('/api/rooms').catch(() => []);
  renderRoomIcons();
}

function renderRoomIcons() {
  const el = $('nav-rooms');
  el.innerHTML = S.rooms.map(r => `
    <div class="server glass ${r.id === S.roomId ? 'active' : ''}"
         data-rid="${r.id}" title="${r.name}"
         style="font-size:1.3rem;font-weight:700">
      ${r.name.charAt(0).toUpperCase()}
    </div>
  `).join('');
  el.querySelectorAll('[data-rid]').forEach(btn => {
    btn.addEventListener('click', () => selectRoom(btn.dataset.rid));
  });
}

async function selectRoom(id) {
  S.roomId = id;
  S.room   = S.rooms.find(r => r.id === id);
  if (!S.room) return;

  S.view = 'chat';
  $('empty-state').classList.add('hidden');
  $('chat-wrap').classList.remove('hidden');
  $('friends-wrap').classList.add('hidden');
  $('dm-wrap').classList.add('hidden');
  $('btn-friends').classList.remove('active');

  $('ch-name').textContent   = S.room.name;
  $('sb-title').textContent  = S.room.name;
  $('btn-room-menu').classList.remove('hidden');
  $('text-sec').style.display      = '';
  $('txt-ch-name').textContent     = S.room.name.toLowerCase().replace(/\s+/g, '-');
  $('voice-sec').style.display     = '';
  $('invite-sec').style.display    = '';
  $('invite-code-txt').textContent = S.room.invite;
  $('vs-room-name').textContent    = 'Голосовой чат / ' + S.room.name;
  $('members-panel').style.display = '';

  renderRoomIcons();

  const [members, messages] = await Promise.all([
    api(`/api/rooms/${id}/members`).catch(() => []),
    api(`/api/rooms/${id}/messages`).catch(() => []),
  ]);
  S.members  = members;
  S.messages = messages;

  renderMembers();
  renderMessages($('messages'), S.messages);
  scrollEl($('messages'), false);

  // Don't clear voice if we're in voice in this same room
  if (S.voice.roomId !== id) {
    S.voiceUsers.clear();
    S.voiceRoom = [];
  }
  renderVoiceCard();

  // Request current voice state from server
  S.socket.emit('voice:get', id);
}

// ═══════════════════════════════════════════════════════════════
// Chat / Messages  —  "island" grouping
// ═══════════════════════════════════════════════════════════════
function renderMessages(container, msgs) {
  container.innerHTML = '';
  let lastDate   = null;
  let lastIsland = null;
  let lastUid    = null;
  let lastTs     = 0;

  msgs.forEach(m => {
    const d = formatDate(m.ts);
    if (d !== lastDate) {
      lastDate = d; lastUid = null; lastIsland = null;
      container.insertAdjacentHTML('beforeend',
        `<div class="date-divider"><span>${d}</span></div>`);
    }
    const grouped = m.user_id === lastUid && (m.ts - lastTs) < 5 * 60 * 1000;
    lastUid = m.user_id;
    lastTs  = m.ts;

    if (grouped && lastIsland) {
      const bubble = lastIsland.querySelector('.bubble');
      const p = document.createElement('p');
      p.className = 'msg-follow';
      p.dataset.id = m.id;
      p.dataset.ts = m.ts;
      p.innerHTML = `<span class="msg-time-inline">${formatTime(m.ts)}</span>${escHtml(m.content)}`;
      bubble.appendChild(p);
      lastIsland.dataset.ts = m.ts;
    } else {
      const div = buildMsgEl(m);
      container.appendChild(div);
      lastIsland = div;
    }
  });
}

function buildMsgEl(m) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.dataset.id  = m.id;
  div.dataset.uid = m.user_id || m.from_id;
  div.dataset.ts  = m.ts;
  div.innerHTML = `
    <span class="pix msg-ava" style="width:48px;height:48px;cursor:pointer" data-uid="${m.user_id || m.from_id}">${avatarHTML(m, 48)}</span>
    <div class="bubble">
      <div class="mhead">
        <span class="author" style="color:${nameColor(m)}" data-uid="${m.user_id || m.from_id}" style="cursor:pointer">${escHtml(m.name || m.username)}</span>
        <span class="time">${formatTime(m.ts)}</span>
      </div>
      <p>${escHtml(m.content)}</p>
    </div>
  `;
  // Click to open mini profile
  div.querySelector('.msg-ava').addEventListener('click', (e) => { e.stopPropagation(); openMiniProfile(m.user_id || m.from_id, e.currentTarget); });
  div.querySelector('.author').addEventListener('click', (e) => { e.stopPropagation(); openMiniProfile(m.user_id || m.from_id, e.currentTarget); });
  return div;
}

function appendMessage(msg, container) {
  // Find last .msg island in this container
  let lastIsland = null;
  for (let i = container.children.length - 1; i >= 0; i--) {
    if (container.children[i].classList.contains('msg')) {
      lastIsland = container.children[i];
      break;
    }
  }
  const uid = msg.user_id || msg.from_id;
  const lastUid = lastIsland?.dataset.uid;
  const lastTs  = parseInt(lastIsland?.dataset.ts || '0');
  const grouped = uid === lastUid && (msg.ts - lastTs) < 5 * 60 * 1000;

  if (grouped && lastIsland) {
    const bubble = lastIsland.querySelector('.bubble');
    const p = document.createElement('p');
    p.className = 'msg-follow';
    p.dataset.id = msg.id;
    p.dataset.ts = msg.ts;
    p.innerHTML = `<span class="msg-time-inline">${formatTime(msg.ts)}</span>${escHtml(msg.content)}`;
    bubble.appendChild(p);
    lastIsland.dataset.ts = msg.ts;
  } else {
    const div = buildMsgEl(msg);
    container.appendChild(div);
  }
}

function scrollEl(el, smooth = true) {
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function sendMessage() {
  const input = $('msg-input');
  const text  = input.value.trim();
  if (!text || !S.roomId) return;
  S.socket.emit('msg', { roomId: S.roomId, content: text });
  input.value = '';
  input.style.height = '';
}

// ═══════════════════════════════════════════════════════════════
// DM
// ═══════════════════════════════════════════════════════════════
async function openDM(user) {
  S.dmWith = user;
  S.view   = 'dm';

  $('empty-state').classList.add('hidden');
  $('chat-wrap').classList.add('hidden');
  $('friends-wrap').classList.add('hidden');
  $('dm-wrap').classList.remove('hidden');
  $('members-panel').style.display = 'none';

  $('dm-hdr-ava').innerHTML = avatarHTML(user, 36);
  $('dm-hdr-name').textContent = user.name || user.username;
  $('dm-hdr-name').style.color = nameColor(user);

  // Load DM history
  const msgs = await api(`/api/dm/${user.id}`).catch(() => []);
  S.dmMessages = msgs;
  renderMessages($('dm-messages'), msgs.map(m => ({ ...m, user_id: m.from_id })));
  scrollEl($('dm-messages'), false);
  closeMiniProfile();
  $('dm-input').focus();
}

function sendDM() {
  const input = $('dm-input');
  const text  = input.value.trim();
  if (!text || !S.dmWith) return;
  S.socket.emit('dm:send', { toId: S.dmWith.id, content: text });
  input.value = '';
  input.style.height = '';
}

function callDM(userId) {
  const target = S.dmWith;
  S.dmCallWith  = target;
  S.dmCallState = 'calling';
  S.socket.emit('dm:ring', { toId: userId });
  showDMCallOverlay(target, 'calling');
  S.dmCallTimeout = setTimeout(() => {
    if (S.dmCallState === 'calling') {
      S.socket.emit('dm:ring:cancel', { toId: userId });
      $('dm-call-ov').classList.add('hidden');
      S.dmCallWith = null;
      S.dmCallState = null;
      toast('Нет ответа');
    }
  }, 30000);
}

function joinDMVoice(otherUser) {
  S.dmCallWith = otherUser;
  const dmRoomId = 'dm:' + [S.me.id, otherUser.id].sort().join('_');
  S.voice.join(dmRoomId).then(() => {
    $('voice-status').classList.remove('hidden');
    $('vs-room-name').textContent = 'Личный звонок';
    startVoiceTimer();
    showDMCallOverlay(otherUser, 'connected');
  }).catch(e => toast('Ошибка микрофона: ' + e.message, 'error'));
}

function showDMCallOverlay(other, state) {
  S.dmCallState = state;
  $('dmc-them-ava').innerHTML = avatarHTML(other, 100);
  $('dmc-them-name').textContent = other.name || other.username;
  if (state === 'calling') {
    $('dmc-phase').textContent = 'Звоним...';
    $('dmc-timer').classList.add('hidden');
    $('dmc-me').style.display = 'none';
  } else {
    $('dmc-phase').textContent = 'Личный звонок';
    $('dmc-timer').classList.remove('hidden');
    $('dmc-me').style.display = 'flex';
    $('dmc-me-ava').innerHTML = avatarHTML(S.me, 100);
    $('dmc-me-name').textContent = S.me.name || S.me.username;
    updateDMCallMuteBtn();
  }
  $('dmc-audio-panel').classList.add('hidden');
  $('dm-call-ov').classList.remove('hidden');
}

function updateDMCallMuteBtn() {
  const btn = $('dmc-btn-mute');
  if (!btn) return;
  btn.classList.toggle('muted', S.muted);
  btn.innerHTML = S.muted
    ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`
    : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`;
}

function endDMCall(notifyOther = true) {
  clearTimeout(S.dmCallTimeout);
  if (notifyOther && S.dmCallWith) {
    S.socket.emit('dm:call:end', { toId: S.dmCallWith.id });
  }
  S.voice.leave();
  S.voiceUsers.clear();
  S.voiceRoom = S.voiceRoom.filter(id => id !== S.me.id);
  stopVoiceTimer();
  S.muted = false;
  updateMuteBtn();
  $('voice-status').classList.add('hidden');
  $('voice-status').classList.remove('q-mid', 'q-bad'); $('voice-status').classList.add('q-good');
  $('vs-ping').textContent = '';
  $('dm-call-ov').classList.add('hidden');
  $('dmc-audio-panel').classList.add('hidden');
  S.dmCallWith  = null;
  S.dmCallState = null;
}

// ═══════════════════════════════════════════════════════════════
// Voice
// ═══════════════════════════════════════════════════════════════
async function joinVoice() {
  if (!S.roomId) return;
  try {
    await S.voice.join(S.roomId);
    playJoinSound();
    $('btn-voice').textContent = 'Выйти';
    $('btn-voice').classList.add('in-voice');
    $('voice-status').classList.remove('hidden');
    $('vs-room-name').textContent = 'Голосовой чат / ' + (S.room?.name || '');
    startVoiceTimer();
    // Optimistically add self to voiceRoom so we appear immediately
    if (!S.voiceRoom.includes(S.me.id)) {
      S.voiceRoom = [...S.voiceRoom, S.me.id];
      S.voiceUsers.set(S.me.id, { muted: S.muted, speaking: false });
    }
    renderVoiceCard();
    renderMembers();
  } catch (e) {
    toast('Не удалось получить доступ к микрофону: ' + e.message, 'error');
  }
}

function leaveVoice() {
  playLeaveSound();
  S.voice.leave();
  S.voiceUsers.clear();
  S.voiceRoom = S.voiceRoom.filter(id => id !== S.me.id);
  $('btn-voice').textContent = 'Войти';
  $('btn-voice').classList.remove('in-voice');
  $('voice-status').classList.add('hidden');
  $('voice-status').classList.remove('q-mid', 'q-bad'); $('voice-status').classList.add('q-good');
  $('vs-ping').textContent = '';
  S.muted = false;
  updateMuteBtn();
  stopVoiceTimer();
  renderVoiceCard();
  renderMembers();
  S.voice.disableCamera();
  $('camera-pip').classList.add('hidden');
  $('btn-vs-camera').classList.remove('on');
  // Screen share cleanup is handled via voice.leave() → stopScreenShare() → onScreenShare callback
}

function toggleMute() {
  S.muted = !S.muted;
  S.voice.setMuted(S.muted);
  updateMuteBtn();
}

function updateMuteBtn() {
  const btn = $('btn-mute');
  btn.classList.toggle('muted', S.muted);
  btn.title = S.muted ? 'Включить микрофон' : 'Выключить микрофон';
}

let _vcTimerInterval = null, _vcStartTime = 0, _vcTimerRunning = false;

function startVoiceTimer() {
  if (_vcTimerRunning) return;
  _vcStartTime = S.voiceStartedAt || Date.now();   // shared start time when known
  _vcTimerRunning = true;
  clearInterval(_vcTimerInterval);
  _vcTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - _vcStartTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const el = $('vac-timer');
    if (el) el.textContent = `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
    const dmEl = $('dmc-timer');
    if (dmEl) dmEl.textContent = h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
      : `${m}:${String(sec).padStart(2,'0')}`;
  }, 1000);
}

function stopVoiceTimer() {
  clearInterval(_vcTimerInterval);
  _vcTimerInterval = null;
  _vcTimerRunning = false;
  if (!S.voice.roomId) S.voiceStartedAt = null;   // forget shared start once we've left
  const el = $('vac-timer');
  if (el) el.textContent = '0:00:00';
}

function renderVoiceCard() {
  const wrap = $('vch-active-wrap');
  if (!wrap) return;
  if (S.voiceRoom.length === 0) {
    wrap.style.display = 'none';
    $('vch-empty-row').style.display = '';
    if (!_vcTimerRunning) stopVoiceTimer();
    return;
  }
  wrap.style.display = '';
  $('vch-empty-row').style.display = 'none';
  const nameEl = $('vac-name');
  if (nameEl) nameEl.textContent = 'Поговорите тут';

  const list = $('vac-list');
  if (!list) return;
  list.innerHTML = '<div class="vch-users">' + S.voiceRoom.map(uid => {
    const member = S.members.find(m => m.id === uid) || { id: uid, name: uid.slice(0,8), avatar: 'default', username: uid };
    const vs = S.voiceUsers.get(uid) || {};
    const isLive = uid === S.me?.id && S.screenSharing;
    return `
      <div class="vuser ${vs.speaking ? 'speaking' : ''}" data-uid="${uid}" style="cursor:pointer" onclick="openMiniProfile('${uid}', this)">
        <span class="pix" style="width:28px;height:28px">${avatarHTML(member, 28)}</span>
        <span class="nick" style="color:${nameColor(member)}">${escHtml(member.name || member.username)}</span>
        ${isLive ? '<span class="live-badge">В эфире</span>' : ''}
        ${vs.muted ? '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity:.5;flex-shrink:0;margin-left:auto"><line x1="2" y1="2" x2="22" y2="22"/><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/><path d="M5 10v2a7 7 0 0 0 12 5"/><line x1="12" y1="19" x2="12" y2="23"/></svg>' : ''}
      </div>
    `;
  }).join('') + '</div>';
}

// ═══════════════════════════════════════════════════════════════
// Members panel
// ═══════════════════════════════════════════════════════════════
function renderMembers() {
  const el = $('members-list');
  if (!S.room || S.view !== 'chat') { el.innerHTML = ''; return; }

  const inVoice  = S.members.filter(m => S.voiceRoom.includes(m.id));
  const online   = S.members.filter(m => S.online.has(m.id)  && !S.voiceRoom.includes(m.id));
  const offline  = S.members.filter(m => !S.online.has(m.id) && !S.voiceRoom.includes(m.id));

  let html = '';
  if (inVoice.length) {
    html += `<div class="members-sec"><div class="members-sec-title">В голосе — ${inVoice.length}</div>`;
    html += inVoice.map(m => memberHTML(m, true)).join('');
    html += '</div><div class="mbr-sep"></div>';
  }
  if (online.length) {
    html += `<div class="members-sec"><div class="members-sec-title">Онлайн — ${online.length}</div>`;
    html += online.map(m => memberHTML(m)).join('');
    html += '</div>';
  }
  if (offline.length) {
    html += '<div class="mbr-sep"></div>';
    html += `<div class="members-sec"><div class="members-sec-title" style="opacity:.5">Не в сети — ${offline.length}</div>`;
    html += offline.map(m => memberHTML(m)).join('');
    html += '</div>';
  }
  el.innerHTML = html;

  el.querySelectorAll('.member').forEach(el => {
    el.addEventListener('click', (e) => openMiniProfile(el.dataset.uid, el));
  });
}

function memberHTML(m, inVoice = false) {
  const vs       = S.voiceUsers.get(m.id) || {};
  const speaking = vs.speaking && inVoice;
  const dotCls   = inVoice ? 'dot dot-online' : `dot ${onlineDot(m.id)}`;
  return `
    <div class="member ${inVoice ? 'in-voice' : ''} ${speaking ? 'speaking' : ''}" data-uid="${m.id}" style="cursor:pointer">
      <span class="pix" style="width:42px;height:42px">
        ${avatarHTML(m, 42)}
        <span class="${dotCls}"></span>
      </span>
      <div class="info">
        <b style="color:${nameColor(m)}">${escHtml(m.name || m.username)}</b>
        ${inVoice ? `<small><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> ${vs.muted ? 'Микрофон выкл.' : 'В голосовом чате'}</small>` : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════
// Mini profile
// ═══════════════════════════════════════════════════════════════
let _miniProfileUid = null;

async function openMiniProfile(uid, anchor) {
  if (uid === _miniProfileUid) { closeMiniProfile(); return; }
  _miniProfileUid = uid;

  // Fetch full profile
  let profile;
  try { profile = await api(`/api/users/${uid}`); } catch { return; }

  const mp = $('mini-profile');
  $('mp-ava').innerHTML = `<div style="width:72px;height:72px;border-radius:50%;overflow:hidden;border:3px solid rgba(255,255,255,0.2)">${avatarHTML(profile, 72)}</div>`;
  $('mp-name').textContent = profile.name || profile.username;
  $('mp-name').style.color = nameColor(profile);
  $('mp-username').textContent = '@' + profile.username;
  $('mp-bio').textContent = profile.bio || '';
  $('mp-bio').style.display = profile.bio ? '' : 'none';
  const mpDotCls = !S.online.has(uid) ? 'offline' : S.statuses.get(uid) === 'dnd' ? 'dnd' : 'online';
  $('mp-online').className = 'mp-online ' + mpDotCls;
  $('mp-online').title = statusLabel(uid);

  // Friend button
  const fb = $('mp-btn-friend');
  if (profile.friendStatus === 'friends') {
    fb.textContent = '✓ Друзья'; fb.className = 'mp-btn';
    fb.onclick = null;
  } else if (profile.friendStatus === 'sent') {
    fb.textContent = '⌛ Заявка отправлена'; fb.className = 'mp-btn';
    fb.onclick = null;
  } else if (profile.friendStatus === 'received') {
    fb.textContent = '✓ Принять заявку'; fb.className = 'mp-btn primary';
    fb.onclick = () => { api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ fromId: uid }) }).then(() => toast('Принято!', 'success')).catch(() => {}); };
  } else {
    fb.textContent = '+ Добавить в друзья'; fb.className = 'mp-btn';
    fb.onclick = () => { api('/api/friends/add', { method: 'POST', body: JSON.stringify({ username: profile.username }) }).then(() => { toast('Заявка отправлена!', 'success'); fb.textContent = '⌛ Заявка отправлена'; fb.onclick = null; }).catch(e => toast(e.message, 'error')); };
  }

  // Block button
  const bb = $('mp-btn-block');
  if (profile.blocked) {
    bb.textContent = '🔓 Разблокировать'; bb.className = 'mp-btn';
    bb.onclick = () => { api(`/api/users/${uid}/block`, { method: 'DELETE' }).then(() => { toast('Разблокирован'); openMiniProfile(uid, anchor); }).catch(() => {}); };
  } else {
    bb.textContent = '🚫 Заблокировать'; bb.className = 'mp-btn danger';
    bb.onclick = () => { if (confirm('Заблокировать этого пользователя?')) api(`/api/users/${uid}/block`, { method: 'POST' }).then(() => { toast('Заблокирован'); closeMiniProfile(); }).catch(() => {}); };
  }

  // Hide DM/call buttons for self
  $('mp-btn-dm').style.display   = uid === S.me.id ? 'none' : '';
  $('mp-btn-call').style.display = uid === S.me.id ? 'none' : '';
  $('mp-btn-friend').style.display = uid === S.me.id ? 'none' : '';
  $('mp-btn-block').style.display  = uid === S.me.id ? 'none' : '';

  $('mp-btn-dm').onclick   = () => { const u = S.members.find(m => m.id === uid) || S.friends.find(f => f.id === uid) || profile; openDM(u); };
  $('mp-btn-call').onclick = () => { callDM(uid); closeMiniProfile(); };

  // Position
  mp.classList.remove('hidden');
  const rect = anchor?.getBoundingClientRect?.() || { right: window.innerWidth / 2, top: window.innerHeight / 2 };
  const mpW = 280, mpH = mp.offsetHeight || 320;
  let left = rect.right + 8;
  let top  = rect.top;
  if (left + mpW > window.innerWidth - 8)  left = rect.left - mpW - 8;
  if (top  + mpH > window.innerHeight - 8) top  = window.innerHeight - mpH - 8;
  if (top < 8) top = 8;
  mp.style.left = left + 'px';
  mp.style.top  = top  + 'px';
}

function closeMiniProfile() {
  _miniProfileUid = null;
  $('mini-profile').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════
// Friends
// ═══════════════════════════════════════════════════════════════
async function loadFriends() {
  const data = await api('/api/friends').catch(() => ({ friends: [], pending: [] }));
  S.friends = data.friends;
  S.pending = data.pending;
}

async function showFriendsView() {
  S.view = 'friends';
  $('empty-state').classList.add('hidden');
  $('chat-wrap').classList.add('hidden');
  $('friends-wrap').classList.remove('hidden');
  $('dm-wrap').classList.add('hidden');
  $('members-list').innerHTML = '';
  $('members-panel').style.display = 'none';
  $('sb-title').textContent   = 'Друзья';
  $('btn-room-menu').classList.add('hidden');
  $('text-sec').style.display      = 'none';
  $('voice-sec').style.display     = 'none';
  $('invite-sec').style.display    = 'none';
  document.querySelectorAll('[data-rid]').forEach(e => e.classList.remove('active'));
  $('btn-friends').classList.add('active');
  // Load DM conversations
  S.dmConvos = await api('/api/dm/convos').catch(() => []);
  renderFriends();
}

function renderFriends() {
  if (S.view !== 'friends') return;
  const el = $('friends-content');
  let html = '';

  // DM conversations section
  if (S.dmConvos.length) {
    html += `<div class="fr-section"><div class="fr-sec-title">Личные сообщения</div>`;
    html += S.dmConvos.map(u => {
      const dotCls = onlineDot(u.id);
      return `
        <div class="fr-item fr-dm-item" data-uid="${u.id}" data-udata="${escHtml(JSON.stringify(u))}">
          <div class="fr-ava">
            ${avatarHTML(u, 38)}
            <span class="dot ${dotCls}"></span>
          </div>
          <div class="fr-info">
            <div class="fr-name" style="color:${nameColor(u)}">${escHtml(u.name || u.username)}</div>
            <div class="fr-sub">${u.last_msg ? escHtml(u.last_msg.slice(0, 40)) : statusLabel(u.id)}</div>
          </div>
        </div>
      `;
    }).join('');
    html += '</div>';
  }

  // Pending requests
  if (S.pending.length) {
    html += `<div class="fr-section"><div class="fr-sec-title">Заявки в друзья — ${S.pending.length}</div>`;
    html += S.pending.map(u => `
      <div class="fr-item" data-uid="${u.id}">
        <div class="fr-ava">
          ${avatarHTML(u, 38)}
          <span class="dot ${onlineDot(u.id)}"></span>
        </div>
        <div class="fr-info">
          <div class="fr-name" style="color:${nameColor(u)}">${escHtml(u.name || u.username)}</div>
          <div class="fr-sub">@${escHtml(u.username)}</div>
        </div>
        <div class="fr-btns">
          <button class="fr-btn accept" onclick="acceptFriend('${u.id}')">✓ Принять</button>
          <button class="fr-btn reject" onclick="rejectFriend('${u.id}')">✕</button>
        </div>
      </div>
    `).join('');
    html += '</div>';
  }

  const online  = S.friends.filter(f => S.online.has(f.id));
  const offline = S.friends.filter(f => !S.online.has(f.id));

  if (online.length) {
    html += `<div class="fr-section"><div class="fr-sec-title">Онлайн — ${online.length}</div>`;
    html += online.map(f => friendHTML(f)).join('');
    html += '</div>';
  }
  if (offline.length) {
    html += `<div class="fr-section"><div class="fr-sec-title" style="opacity:.5">Не в сети — ${offline.length}</div>`;
    html += offline.map(f => friendHTML(f)).join('');
    html += '</div>';
  }
  if (!S.friends.length && !S.pending.length && !S.dmConvos.length) {
    html = `<div style="text-align:center;padding:40px;font-size:18px;color:var(--txt3)">Пока нет друзей.<br>Добавь первого!</div>`;
  }
  el.innerHTML = html;

  // DM conversation items
  el.querySelectorAll('.fr-dm-item').forEach(item => {
    item.addEventListener('click', () => {
      try {
        const u = JSON.parse(item.dataset.udata);
        openDM(u);
      } catch {}
    });
  });

  // Friend items (click to open DM)
  el.querySelectorAll('.fr-item:not(.fr-dm-item)').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.fr-btns')) return;
      const uid = item.dataset.uid;
      const u = S.friends.find(f => f.id === uid) || S.pending.find(f => f.id === uid);
      if (u) openDM(u);
    });
  });
}

function friendHTML(u, lastMsg) {
  const dotCls = onlineDot(u.id);
  const sub    = lastMsg ? escHtml(lastMsg.slice(0, 40)) : statusLabel(u.id);
  return `
    <div class="fr-item" data-uid="${u.id}" style="cursor:pointer">
      <div class="fr-ava">
        ${avatarHTML(u, 38)}
        <span class="dot ${dotCls}"></span>
      </div>
      <div class="fr-info">
        <div class="fr-name" style="color:${nameColor(u)}">${escHtml(u.name || u.username)}</div>
        <div class="fr-sub" style="color:${lastMsg ? 'var(--ink-dim)' : (S.online.has(u.id) ? '#23a55a' : 'var(--ink-faint)')}">${sub}</div>
      </div>
      <button class="fr-btn" onclick="event.stopPropagation();openDM(${JSON.stringify(u).replace(/"/g,'&quot;')})" style="padding:5px 10px;font-size:.75rem">💬</button>
      <button class="fr-btn" onclick="event.stopPropagation();callDM('${u.id}')" style="padding:5px 10px;font-size:.75rem">📞</button>
    </div>
  `;
}

async function acceptFriend(fromId) {
  await api('/api/friends/accept', { method: 'POST', body: JSON.stringify({ fromId }) }).catch(() => {});
  S.pending = S.pending.filter(u => u.id !== fromId);
  const data = await api('/api/friends').catch(() => ({ friends: [], pending: [] }));
  S.friends = data.friends; S.pending = data.pending;
  renderFriends();
}
async function rejectFriend(fromId) {
  await api('/api/friends/reject', { method: 'POST', body: JSON.stringify({ fromId }) }).catch(() => {});
  S.pending = S.pending.filter(u => u.id !== fromId);
  renderFriends();
}

// ═══════════════════════════════════════════════════════════════
// User bar
// ═══════════════════════════════════════════════════════════════
const STATUS_LABEL = { online: 'В сети', dnd: 'Не беспокоить', invisible: 'Невидимка' };

function renderUserBar() {
  $('ub-avatar').innerHTML = avatarHTML(S.me, 34) + '<span class="status-dot s-' + S.myStatus + '" id="ub-status-dot"></span>';
  $('ub-name').textContent = S.me.name || S.me.username;
  $('ub-name').style.color = nameColor(S.me);
  $('ub-tag').textContent  = STATUS_LABEL[S.myStatus] || 'В сети';
}

// ═══════════════════════════════════════════════════════════════
// Settings
// ═══════════════════════════════════════════════════════════════
const COLOR_PRESETS = [
  '#f4a933','#e85d75','#5b9cf6','#56d364','#c47fda',
  '#4ec9b0','#f08a5d','#6bcfef','#e4a9f3','#ff6b6b',
  '#ffd93d','#6bcb77','#4d96ff','#ffffff','#aaaaaa',
];

// ── Screen share picker ───────────────────────────────────────
const MONITOR_ICON = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
const DESKTOP_ICON = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="6" y="7" width="6" height="6" rx="1"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

async function openScreenPicker() {
  const grid = $('sp-grid');
  grid.innerHTML = '<div class="sp-loading">Загружаю источники…</div>';
  $('btn-sp-share').disabled = true;
  showModal('modal-screen');

  // Always offer full desktop as the first, always-working option
  const sources = [{ id: '__desktop__', name: 'Весь рабочий стол', icon: DESKTOP_ICON, direct: false }];

  if (window.electronAPI?.getScreenSources) {
    try {
      const list = await window.electronAPI.getScreenSources();
      list.forEach(s => sources.push({
        id: s.id, name: s.name,
        thumbnail: s.thumbnail, direct: s.direct,
        icon: s.isScreen ? MONITOR_ICON : DESKTOP_ICON,
        bounds: s.bounds, allBounds: s.allBounds,
      }));
    } catch {}
  }

  grid.innerHTML = '';
  sources.forEach(src => {
    const item = document.createElement('div');
    item.className = 'sp-item';
    item.dataset.sourceId = src.id;
    item.dataset.direct   = src.direct ? '1' : '';
    if (src.bounds)    item.dataset.bounds    = JSON.stringify(src.bounds);
    if (src.allBounds) item.dataset.allBounds = JSON.stringify(src.allBounds);
    const thumb = src.thumbnail
      ? `<img src="${src.thumbnail}" alt="">`
      : `<div class="sp-item-thumb-empty">${src.icon}</div>`;
    item.innerHTML = `${thumb}<div class="sp-item-name">${escHtml(src.name)}</div>`;
    item.addEventListener('click', () => {
      grid.querySelectorAll('.sp-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');
      $('btn-sp-share').disabled = false;
    });
    grid.appendChild(item);
  });

  grid.querySelector('.sp-item')?.click();
}

// ── Noise-suppression mode selector ───────────────────────────
const NS_DESC = {
  off:      'Без обработки — слышен весь фоновый шум.',
  standard: 'Убирает постоянный шум (вентилятор, гул, фон). Голос максимально естественный.',
  ghoul:    'Максимальное подавление: глушит клавиатуру, мышь и резкие звуки. Слышен только голос.',
};

function bindNoiseModes(containerId, descId) {
  const cont = $(containerId);
  if (!cont || !S.voice) return;
  const desc = descId ? $(descId) : null;
  const paint = () => {
    cont.querySelectorAll('.ns-mode').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === S.voice.noiseMode));
    if (desc) desc.textContent = NS_DESC[S.voice.noiseMode] || '';
  };
  cont.querySelectorAll('.ns-mode').forEach(btn => {
    btn.onclick = async () => { await S.voice.setNoiseMode(btn.dataset.mode); paint(); };
  });
  paint();
}

async function openSettings() {
  $('set-name').value     = S.me.name     || '';
  $('set-username').value = S.me.username || '';
  $('set-bio').value      = S.me.bio      || '';
  $('profile-ava-preview').innerHTML = avatarHTML(S.me, 80);

  // Color presets
  const presetsEl = $('color-presets');
  presetsEl.innerHTML = COLOR_PRESETS.map(c =>
    `<div class="color-swatch ${S.me.name_color === c ? 'active' : ''}" style="background:${c}" data-color="${c}" title="${c}"></div>`
  ).join('') + `<div class="color-swatch reset-swatch" data-color="" title="По умолчанию">✕</div>`;

  presetsEl.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      presetsEl.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      const c = sw.dataset.color;
      $('set-color-hex').value = c;
      if (c) $('set-color-pick').value = c;
      updateColorPreview();
    });
  });

  $('set-color-hex').value = S.me.name_color || '';
  if (S.me.name_color) $('set-color-pick').value = S.me.name_color;
  updateColorPreview();

  // Voice processing settings
  const sAuto = $('set-auto-chk');
  const sSens  = $('set-sens'),      sSensVal = $('set-sens-val'), sManual = $('set-manual-row');
  bindNoiseModes('set-ns-modes', 'set-ns-desc');
  sAuto.checked        = S.voice.autoGate;
  sSens.value          = S.voice.noiseThreshold;
  sSensVal.textContent = S.voice.noiseThreshold;
  sManual.classList.toggle('hidden', S.voice.autoGate);

  sAuto.onchange  = (e) => {
    S.voice.setAutoGate(e.target.checked);
    sManual.classList.toggle('hidden', e.target.checked);
  };
  sSens.oninput = (e) => {
    const v = parseInt(e.target.value, 10);
    sSensVal.textContent = v;
    S.voice.setSensitivity(v);
  };

  showModal('modal-settings');
  await loadAudioDevices();
}

function updateColorPreview() {
  const c = $('set-color-hex').value.trim();
  $('color-preview-name').textContent = S.me.name || S.me.username;
  $('color-preview-name').style.color = c || nameColor(S.me);
}

async function loadAudioDevices() {
  const { mics, speakers } = await VoiceEngine.getDevices();
  fillSelect($('sel-mic'),     mics,     S.voice.micId);
  fillSelect($('sel-speaker'), speakers, S.voice.speakerId);
  startMicMeter();
}

function fillSelect(sel, devices, currentId) {
  sel.innerHTML = devices.map(d =>
    `<option value="${d.deviceId}" ${d.deviceId === currentId ? 'selected' : ''}>${d.label || d.deviceId.slice(0,20)}</option>`
  ).join('');
  if (!devices.length) sel.innerHTML = '<option value="">Нет устройств</option>';
}

let _micMeterStop = null;
function startMicMeter() {
  if (_micMeterStop) { _micMeterStop(); _micMeterStop = null; }
  const micId = $('sel-mic').value;
  navigator.mediaDevices.getUserMedia({ audio: micId ? { deviceId: { exact: micId } } : true, video: false })
    .then(stream => {
      try {
        const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser();
        analyser.fftSize = 256; src.connect(analyser);
        const buf = new Uint8Array(analyser.frequencyBinCount);
        let active = true;
        _micMeterStop = () => { active = false; ctx.close().catch(() => {}); stream.getTracks().forEach(t => t.stop()); };
        const tick = () => {
          if (!active) return;
          analyser.getByteFrequencyData(buf);
          const avg = buf.reduce((a,b) => a+b, 0) / buf.length;
          const bar = $('mic-meter');
          if (bar) bar.style.width = Math.min(100, avg * 2.5) + '%';
          requestAnimationFrame(tick);
        };
        tick();
      } catch {}
    }).catch(() => {});
}
function stopMicMeter() { if (_micMeterStop) { _micMeterStop(); _micMeterStop = null; } }

// ═══════════════════════════════════════════════════════════════
// Modals
// ═══════════════════════════════════════════════════════════════
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }

// ═══════════════════════════════════════════════════════════════
// UI event wiring
// ═══════════════════════════════════════════════════════════════
function setupUI() {
  // Close modal on overlay click / X
  document.querySelectorAll('.modal-ov').forEach(ov => {
    ov.addEventListener('click', e => { if (e.target === ov) { hideModal(ov.id); stopMicMeter(); } });
  });
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer?.dataset.close) { hideModal(closer.dataset.close); stopMicMeter(); }
  });

  // Close mini profile on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#mini-profile') && !e.target.closest('[data-uid]') && !e.target.closest('.msg-ava') && !e.target.closest('.author')) {
      closeMiniProfile();
    }
  });

  // Nav: friends
  $('btn-friends').addEventListener('click', () => showFriendsView());

  // Nav: create room (+ tabs for join)
  const openCreateModal = (tab = 'create') => {
    $('create-name').value = '';
    $('join-code').value   = '';
    $('create-err').textContent = '';
    showModal('modal-create');
    switchCreateTab(tab);
    setTimeout(() => (tab === 'create' ? $('create-name') : $('join-code')).focus(), 50);
  };

  $('btn-new-room').addEventListener('click', () => openCreateModal('create'));
  $('empty-create').addEventListener('click', () => openCreateModal('create'));

  $('mc-tab-create').addEventListener('click', () => switchCreateTab('create'));
  $('mc-tab-join').addEventListener('click',   () => switchCreateTab('join'));

  function switchCreateTab(tab) {
    $('mc-tab-create').classList.toggle('active', tab === 'create');
    $('mc-tab-join').classList.toggle('active',   tab === 'join');
    $('mc-body-create').classList.toggle('hidden', tab !== 'create');
    $('mc-body-join').classList.toggle('hidden',   tab !== 'join');
    $('btn-create-ok').classList.toggle('hidden', tab !== 'create');
    $('btn-join-ok').classList.toggle('hidden',   tab !== 'join');
    $('modal-create-title').textContent = tab === 'create' ? 'Новая группа' : 'Войти по коду';
    $('create-err').textContent = '';
  }

  $('btn-create-ok').addEventListener('click', async () => {
    const name = $('create-name').value.trim();
    if (!name) return;
    try {
      const room = await api('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) });
      S.rooms.push(room);
      renderRoomIcons();
      hideModal('modal-create');
      selectRoom(room.id);
    } catch (e) { $('create-err').textContent = e.message; }
  });

  $('btn-join-ok').addEventListener('click', async () => {
    const invite = $('join-code').value.toUpperCase().trim();
    if (!invite) return;
    try {
      const room = await api('/api/rooms/join', { method: 'POST', body: JSON.stringify({ invite }) });
      if (!S.rooms.find(r => r.id === room.id)) S.rooms.push(room);
      // Subscribe this socket to the new room's events
      S.socket.emit('room:socket:join', room.id);
      renderRoomIcons();
      hideModal('modal-create');
      selectRoom(room.id);
    } catch (e) { $('create-err').textContent = e.message; }
  });

  $('create-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-ok').click(); });
  $('join-code').addEventListener('keydown',   e => { if (e.key === 'Enter') $('btn-join-ok').click(); });

  // Copy invite
  $('btn-copy-invite').addEventListener('click', () => {
    navigator.clipboard.writeText($('invite-code-txt').textContent).then(() => toast('Код скопирован!', 'success'));
  });

  // Voice
  $('vch-empty-row').addEventListener('click', () => { if (!S.roomId) return; joinVoice(); });
  $('btn-voice').addEventListener('click', () => { if (S.voice.roomId) leaveVoice(); else joinVoice(); });
  $('btn-voice-leave').addEventListener('click', leaveVoice);
  $('btn-vs-screen').addEventListener('click', () => {
    if (!S.voice.roomId) { toast('Сначала войди в голосовой чат', ''); return; }
    if (S.voice.screenStream) { S.voice.stopScreenShare(); return; }
    openScreenPicker();
  });

  // Camera toggle
  $('btn-vs-camera').addEventListener('click', async () => {
    const btn = $('btn-vs-camera');
    if (S.voice.cameraEnabled) {
      S.voice.disableCamera();
      btn.classList.remove('on');
      $('camera-pip').classList.add('hidden');
    } else {
      try {
        await S.voice.enableCamera();
        btn.classList.add('on');
        const pip = $('camera-pip');
        $('camera-video').srcObject = S.voice.localVideoStream;
        pip.classList.remove('hidden');
      } catch (e) {
        toast('Не удалось включить камеру: ' + e.message, 'error');
      }
    }
  });
  $('btn-pip-close').addEventListener('click', () => {
    S.voice.disableCamera();
    $('btn-vs-camera').classList.remove('on');
    $('camera-pip').classList.add('hidden');
  });

  // Mute
  $('btn-mute').addEventListener('click', toggleMute);

  // Send message
  $('btn-send').addEventListener('click', sendMessage);
  $('msg-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    setTimeout(() => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }, 0);
  });

  // DM
  $('btn-dm-back').addEventListener('click', () => {
    if (S.rooms.length) selectRoom(S.rooms[0].id);
    else showFriendsView();
  });
  $('btn-dm-call').addEventListener('click', () => { if (S.dmWith) callDM(S.dmWith.id); });
  $('btn-dm-send').addEventListener('click', sendDM);
  $('dm-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDM(); }
    setTimeout(() => { e.target.style.height = ''; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }, 0);
  });

  // Incoming call
  $('btn-ring-accept').addEventListener('click', () => {
    if (!S.ringFrom) return;
    const from = S.ringFrom;
    S.socket.emit('dm:ring:accept', { toId: from.id });
    $('call-ring').classList.add('hidden');
    S.ringFrom = null;
    joinDMVoice(from);
  });
  $('btn-ring-decline').addEventListener('click', () => {
    if (S.ringFrom) S.socket.emit('dm:ring:decline', { toId: S.ringFrom.id });
    $('call-ring').classList.add('hidden');
    S.ringFrom = null;
  });

  // DM call overlay buttons
  $('dmc-btn-end').addEventListener('click', () => {
    if (S.dmCallState === 'calling') {
      clearTimeout(S.dmCallTimeout);
      if (S.dmCallWith) S.socket.emit('dm:ring:cancel', { toId: S.dmCallWith.id });
      $('dm-call-ov').classList.add('hidden');
      S.dmCallWith = null;
      S.dmCallState = null;
    } else {
      endDMCall(true);
    }
  });
  $('dmc-btn-mute').addEventListener('click', () => {
    S.muted = !S.muted;
    S.voice.setMuted(S.muted);
    updateMuteBtn();
    updateDMCallMuteBtn();
  });
  $('dmc-btn-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = $('dmc-audio-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) bindNoiseModes('dmc-ns-modes', null);
  });
  // Init audio settings from saved values
  const _savedThres = parseInt(localStorage.getItem('zvonok_threshold') || '10', 10);
  bindNoiseModes('dmc-ns-modes', null);
  $('dmc-sens').value = _savedThres;
  $('dmc-sens-val').textContent = _savedThres;
  $('dmc-sens').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    $('dmc-sens-val').textContent = v;
    S.voice.setSensitivity(v);
  });
  document.addEventListener('click', () => {
    if (!$('dmc-audio-panel').classList.contains('hidden')) {
      $('dmc-audio-panel').classList.add('hidden');
    }
  });
  $('dmc-audio-panel').addEventListener('click', e => e.stopPropagation());

  // Settings
  $('btn-settings').addEventListener('click', openSettings);

  // ── Status menu ───────────────────────────────────────────────
  const statusMenu = $('status-menu');
  $('ub-avatar').addEventListener('click', (e) => {
    e.stopPropagation();
    // update active state
    statusMenu.querySelectorAll('.sopt').forEach(el => {
      el.classList.toggle('active', el.dataset.status === S.myStatus);
    });
    statusMenu.classList.toggle('hidden');
  });
  statusMenu.querySelectorAll('.sopt').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const status = el.dataset.status;
      S.myStatus = status;
      localStorage.setItem('zvonok_status', status);
      renderUserBar();
      statusMenu.classList.add('hidden');
      S.socket.emit('set:status', status);
    });
  });
  document.addEventListener('click', (e) => {
    if (!statusMenu.contains(e.target)) statusMenu.classList.add('hidden');
  });

  $('set-color-hex').addEventListener('input', updateColorPreview);
  $('set-color-pick').addEventListener('input', (e) => {
    $('set-color-hex').value = e.target.value;
    updateColorPreview();
  });

  $('btn-save-profile').addEventListener('click', async () => {
    const name      = $('set-name').value.trim();
    const bio       = $('set-bio').value.trim();
    const nameColor = $('set-color-hex').value.trim();
    if (!name) return;
    try {
      const u = await api('/api/me', { method: 'PATCH', body: JSON.stringify({ name, bio, name_color: nameColor || null }) });
      S.me = { ...S.me, ...u };
      renderUserBar();
      toast('Профиль сохранён', 'success');
      hideModal('modal-settings');
    } catch (e) { toast(e.message, 'error'); }
  });

  // ── Avatar crop ────────────────────────────────────────────────
  const CROP_SIZE = 380;
  const CROP_R    = 152;
  let _cropImg = null, _cropZoom = 1, _cropMinZoom = 1;
  let _cropOX = 0, _cropOY = 0;
  let _dragStart = null;

  function _cropDraw() {
    const cv  = $('ava-crop-canvas');
    const ctx = cv.getContext('2d');
    const CX  = CROP_SIZE / 2, CY = CROP_SIZE / 2;
    const iw  = _cropImg.naturalWidth  * _cropZoom;
    const ih  = _cropImg.naturalHeight * _cropZoom;
    const dx  = CX + _cropOX - iw / 2;
    const dy  = CY + _cropOY - ih / 2;

    ctx.clearRect(0, 0, CROP_SIZE, CROP_SIZE);
    ctx.drawImage(_cropImg, dx, dy, iw, ih);

    // dark overlay with circular hole
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.beginPath();
    ctx.rect(0, 0, CROP_SIZE, CROP_SIZE);
    ctx.arc(CX, CY, CROP_R, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.restore();

    // re-draw image inside circle (so it stays sharp above overlay)
    ctx.save();
    ctx.beginPath();
    ctx.arc(CX, CY, CROP_R, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(_cropImg, dx, dy, iw, ih);
    ctx.restore();

    // border ring
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(CX, CY, CROP_R, 0, Math.PI * 2);
    ctx.stroke();
  }

  function _cropClamp() {
    const iw = _cropImg.naturalWidth  * _cropZoom;
    const ih = _cropImg.naturalHeight * _cropZoom;
    const maxX = Math.max(0, iw / 2 - CROP_R);
    const maxY = Math.max(0, ih / 2 - CROP_R);
    _cropOX = Math.max(-maxX, Math.min(maxX, _cropOX));
    _cropOY = Math.max(-maxY, Math.min(maxY, _cropOY));
  }

  function _openCropModal(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      _cropImg = img;
      _cropMinZoom = Math.max((CROP_R * 2) / img.naturalWidth, (CROP_R * 2) / img.naturalHeight);
      _cropZoom = _cropMinZoom;
      _cropOX = 0; _cropOY = 0;
      $('ava-zoom-slider').value = 0;
      _cropDraw();
      $('modal-avatar-crop').classList.remove('hidden');
    };
    img.src = url;
  }

  // zoom slider
  $('ava-zoom-slider').addEventListener('input', (e) => {
    const t = e.target.value / 100;
    _cropZoom = _cropMinZoom + (_cropMinZoom * 2.5) * t;
    _cropClamp();
    _cropDraw();
  });

  // drag to pan
  const _cv = $('ava-crop-canvas');
  _cv.addEventListener('pointerdown', (e) => {
    _cv.setPointerCapture(e.pointerId);
    _dragStart = { x: e.clientX, y: e.clientY, ox: _cropOX, oy: _cropOY };
  });
  _cv.addEventListener('pointermove', (e) => {
    if (!_dragStart) return;
    _cropOX = _dragStart.ox + (e.clientX - _dragStart.x);
    _cropOY = _dragStart.oy + (e.clientY - _dragStart.y);
    _cropClamp();
    _cropDraw();
  });
  _cv.addEventListener('pointerup', () => { _dragStart = null; });

  // wheel zoom
  _cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    _cropZoom = Math.max(_cropMinZoom, Math.min(_cropMinZoom * 3.5, _cropZoom + delta * _cropMinZoom));
    const t = (_cropZoom - _cropMinZoom) / (_cropMinZoom * 2.5);
    $('ava-zoom-slider').value = Math.round(Math.max(0, Math.min(100, t * 100)));
    _cropClamp();
    _cropDraw();
  }, { passive: false });

  // cancel
  const _closeCrop = () => $('modal-avatar-crop').classList.add('hidden');
  $('btn-crop-cancel').addEventListener('click', _closeCrop);
  $('btn-crop-cancel2').addEventListener('click', _closeCrop);

  // confirm → export → upload
  $('btn-crop-confirm').addEventListener('click', async () => {
    const OUT = 256;
    const out = document.createElement('canvas');
    out.width = out.height = OUT;
    const ctx = out.getContext('2d');
    ctx.beginPath();
    ctx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2);
    ctx.clip();
    const scale = OUT / (CROP_R * 2);
    const CX = CROP_SIZE / 2, CY = CROP_SIZE / 2;
    const iw = _cropImg.naturalWidth  * _cropZoom * scale;
    const ih = _cropImg.naturalHeight * _cropZoom * scale;
    const dx = (CX + _cropOX - _cropImg.naturalWidth  * _cropZoom / 2 - (CX - CROP_R)) * scale;
    const dy = (CY + _cropOY - _cropImg.naturalHeight * _cropZoom / 2 - (CY - CROP_R)) * scale;
    ctx.drawImage(_cropImg, dx, dy, iw, ih);

    out.toBlob(async (blob) => {
      _closeCrop();
      const fd = new FormData();
      fd.append('avatar', blob, 'avatar.jpg');
      try {
        const res  = await fetch('/api/me/avatar', { method: 'POST', headers: { 'Authorization': `Bearer ${S.token}` }, body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        S.me.avatar = data.avatar;   // already carries ?v=<ts> for cache-busting
        $('profile-ava-preview').innerHTML = avatarHTML(S.me, 80);
        renderUserBar();
        toast('Аватарка обновлена!', 'success');
      } catch (err) { toast('Ошибка загрузки: ' + err.message, 'error'); }
    }, 'image/jpeg', 0.92);
  });

  $('btn-change-avatar').addEventListener('click', () => $('avatar-input').click());
  $('avatar-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    _openCropModal(file);
    e.target.value = '';
  });

  $('sel-mic').addEventListener('change',     async (e) => { await S.voice.changeMic(e.target.value);     stopMicMeter(); startMicMeter(); });
  $('sel-speaker').addEventListener('change', async (e) => { await S.voice.changeSpeaker(e.target.value); });
  $('btn-test-mic').addEventListener('click', () => startMicMeter());

  $('btn-logout').addEventListener('click', () => {
    S.voice.leave();
    localStorage.removeItem('zvonok_token');
    localStorage.removeItem('zvonok_user');
    location.href = '/';
  });

  // Add friend
  $('btn-add-friend').addEventListener('click', () => {
    $('friend-input').value = ''; $('friend-search-res').innerHTML = ''; $('friend-err').textContent = '';
    showModal('modal-add-friend');
    setTimeout(() => $('friend-input').focus(), 50);
  });

  let _searchTimer;
  $('friend-input').addEventListener('input', (e) => {
    clearTimeout(_searchTimer);
    const q = e.target.value.trim();
    if (q.length < 2) { $('friend-search-res').innerHTML = ''; return; }
    _searchTimer = setTimeout(async () => {
      const users = await api(`/api/users/search?q=${encodeURIComponent(q)}`).catch(() => []);
      $('friend-search-res').innerHTML = users.map(u => `
        <div class="search-user" data-uid="${u.id}">
          <div class="search-user-ava">${avatarHTML(u, 32)}</div>
          <div class="search-user-info">
            <div class="search-user-name" style="color:${nameColor(u)}">${escHtml(u.name || u.username)}</div>
            <div class="search-user-tag">@${escHtml(u.username)}</div>
          </div>
        </div>
      `).join('');
      $('friend-search-res').querySelectorAll('.search-user').forEach(el => {
        el.addEventListener('click', () => { $('friend-input').value = el.querySelector('.search-user-tag').textContent.slice(1); });
      });
    }, 300);
  });

  $('btn-send-req').addEventListener('click', async () => {
    const username = $('friend-input').value.trim().replace('@', '');
    if (!username) return;
    try {
      await api('/api/friends/add', { method: 'POST', body: JSON.stringify({ username }) });
      toast('Заявка отправлена!', 'success');
      hideModal('modal-add-friend');
    } catch (e) { $('friend-err').textContent = e.message; }
  });
  $('friend-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-send-req').click(); });

  // Room settings via room menu button
  $('btn-room-menu').addEventListener('click', openRoomSettings);
  function openRoomSettings() {
    if (!S.room) return;
    $('room-set-title').textContent = S.room.name;
    $('room-invite-code').textContent = S.room.invite;
    showModal('modal-room-set');
  }

  $('btn-copy-room-invite').addEventListener('click', () => {
    navigator.clipboard.writeText($('room-invite-code').textContent).then(() => toast('Код скопирован!', 'success'));
  });

  $('btn-leave-room').addEventListener('click', async () => {
    if (!S.room) return;
    if (!confirm(`Покинуть комнату "${S.room.name}"?`)) return;
    if (S.voice.roomId === S.roomId) leaveVoice();
    await api(`/api/rooms/${S.roomId}/leave`, { method: 'DELETE' }).catch(() => {});
    S.rooms = S.rooms.filter(r => r.id !== S.roomId);
    S.roomId = null; S.room = null;
    hideModal('modal-room-set');
    renderRoomIcons();
    $('sb-title').textContent = 'Звонок';
    $('btn-room-menu').classList.add('hidden');
    $('voice-sec').style.display  = 'none';
    $('invite-sec').style.display = 'none';
    $('chat-wrap').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
    S.view = 'empty';
    if (S.rooms.length) selectRoom(S.rooms[0].id);
  });

  // Toggle members panel
  $('btn-toggle-members').addEventListener('click', () => {
    S.showMembers = !S.showMembers;
    $('members-panel').style.display = S.showMembers ? '' : 'none';
  });

  // Deafen toggle
  $('btn-deafen').addEventListener('click', () => {
    $('btn-deafen').classList.toggle('deafened');
  });

  // More voice options
  $('btn-vs-more').addEventListener('click', () => openSettings());

  // Voice settings in main settings modal
  let _smoothThresh = 0;
  S.voice.onInputLevel = (lvl, thresh) => {
    const fill   = $('set-level-fill');
    const marker = $('set-level-thresh');
    if (!fill || !marker) return;
    fill.style.width = lvl + '%';
    if (S.voice.autoGate) {
      // Auto mode: hide threshold line, don't touch the slider
      marker.style.display = 'none';
    } else {
      // Manual mode: show smoothed threshold line
      marker.style.display = '';
      _smoothThresh = _smoothThresh * 0.85 + thresh * 0.15;
      marker.style.left = _smoothThresh.toFixed(1) + '%';
    }
  };

  // Stop screen share
  $('btn-screen-share-stop').addEventListener('click', () => S.voice.stopScreenShare());
  $('btn-stop-share').addEventListener('click', () => S.voice.stopScreenShare());

  // Screen overlay controls
  $('btn-screen-ov-close').addEventListener('click', () => $('screen-ov').classList.add('hidden'));
  $('btn-screen-ov-fs').addEventListener('click', () => {
    const vid = $('screen-ov-video');
    if (vid.requestFullscreen) vid.requestFullscreen();
    else if (vid.webkitRequestFullscreen) vid.webkitRequestFullscreen();
  });

  // Screen picker: share button
  $('btn-sp-share').addEventListener('click', async () => {
    const quality = parseInt($('sp-quality').value, 10);
    const fps     = parseInt($('sp-fps').value, 10) || 30;
    const audio   = $('sp-audio').checked;
    const res     = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080] }[quality] || [1280, 720];
    const sel       = $('sp-grid').querySelector('.sp-item.selected');
    const sourceId  = sel?.dataset.sourceId;
    const direct    = sel?.dataset.direct === '1';
    const bounds    = sel?.dataset.bounds    ? JSON.parse(sel.dataset.bounds)    : null;
    const allBounds = sel?.dataset.allBounds ? JSON.parse(sel.dataset.allBounds) : null;
    hideModal('modal-screen');
    await S.voice.startScreenShare({ width: res[0], height: res[1], fps, audio, sourceId, direct, bounds, allBounds });
  });

  $('btn-self-stop').addEventListener('click', () => S.voice.stopScreenShare());

  // Wire voice.onScreenShare callback
  S.voice.onScreenShare = (sharing, stream) => {
    $('btn-vs-screen').classList.toggle('sharing', sharing);
    $('vs-sharing').classList.toggle('hidden', !sharing);
    $('screen-card').classList.toggle('hidden', !sharing);
    const selfOv  = $('screen-self-ov');
    const selfVid = $('screen-self-video');
    if (sharing && stream) {
      selfVid.srcObject = stream;
      selfVid.play().catch(() => {});
      selfOv.classList.remove('hidden');
    } else {
      selfVid.srcObject = null;
      selfOv.classList.add('hidden');
    }
  };

  S.voice.onScreenShareError = (msg) => toast('Демонстрация экрана: ' + msg, 'error');

  // Wire voice.onRemoteScreen callback
  S.voice.onRemoteScreen = (userId, stream) => {
    const ov  = $('screen-ov');
    const vid = $('screen-ov-video');
    if (!stream) { vid.srcObject = null; ov.classList.add('hidden'); return; }
    const user = (S.members || []).find(m => m.id === userId);
    $('screen-ov-who').textContent = (user?.name || 'Участник') + ' демонстрирует экран';
    vid.srcObject = stream;
    vid.play().catch(() => {});
    ov.classList.remove('hidden');
  };

  // Text channel actions
  $('btn-toggle-members-ch').addEventListener('click', () => {
    S.showMembers = !S.showMembers;
    $('members-panel').style.display = S.showMembers ? '' : 'none';
  });
  $('btn-ch-settings').addEventListener('click', () => {
    if (S.room) {
      $('room-set-title').textContent = S.room.name;
      $('room-invite-code').textContent = S.room.invite;
      showModal('modal-room-set');
    }
  });

  // Call button in titlebar
}

// ── Start ──────────────────────────────────────────────────────
init();

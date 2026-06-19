'use strict';
const express      = require('express');
const https        = require('https');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const { v4: uuid } = require('uuid');
const fs           = require('fs');
const os           = require('os');
const crypto       = require('crypto');
const forge        = require('node-forge');
const { initDb, db } = require('./db');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}

// ── Setup ──────────────────────────────────────────────────────────
const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = process.env.ZVONOK_DATA || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const SECRET_PATH = path.join(DATA_DIR, 'secret.key');
const SECRET = fs.existsSync(SECRET_PATH)
  ? fs.readFileSync(SECRET_PATH, 'utf8').trim()
  : (() => {
      const s = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(SECRET_PATH, s);
      return s;
    })();

const IS_PROD = process.env.NODE_ENV === 'production';

let server, io;
if (IS_PROD) {
  server = http.createServer(app);
  io     = new Server(server, { cors: { origin: '*' } });
} else {
  const CERT_PATH = path.join(DATA_DIR, 'cert.json');
  let tlsCreds;
  if (fs.existsSync(CERT_PATH)) {
    tlsCreds = JSON.parse(fs.readFileSync(CERT_PATH, 'utf8'));
  } else {
    console.log('  Генерирую TLS сертификат (~5 сек)...');
    const nets = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal);
    const ips  = nets.map(n => n.address);
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter  = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);
    const attrs = [{ name: 'commonName', value: 'zvonok' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...ips.map(ip => ({ type: 7, ip })),
      ]},
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    tlsCreds = {
      key:  forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(cert),
    };
    fs.writeFileSync(CERT_PATH, JSON.stringify(tlsCreds));
  }
  server = https.createServer(tlsCreds, app);
  io     = new Server(server);
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host.replace(/:\d+$/, '')}:${PORT}${req.url}` });
    res.end();
  }).listen(3001, '0.0.0.0');
}

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── DB Schema ──────────────────────────────────────────────────────
const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id        TEXT PRIMARY KEY,
    username  TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    name      TEXT NOT NULL,
    avatar    TEXT NOT NULL DEFAULT 'default',
    email     TEXT,
    name_color TEXT,
    bio       TEXT DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    created_by TEXT NOT NULL,
    invite     TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    room_id   TEXT NOT NULL,
    user_id   TEXT NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id      TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    ts      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friends (
    from_id    TEXT NOT NULL,
    to_id      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id)
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dm_messages (
    id      TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id   TEXT NOT NULL,
    content TEXT NOT NULL,
    ts      INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );
`;

// ── Helpers ────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: 'Не авторизован' }); }
};

async function getUser(id) {
  return db.get('SELECT id,username,name,avatar,name_color,bio FROM users WHERE id=?', [id]);
}

async function isMember(roomId, userId) {
  return !!(await db.get('SELECT 1 FROM members WHERE room_id=? AND user_id=?', [roomId, userId]));
}

async function isBlocked(a, b) {
  return !!(await db.get('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)', [a, b, b, a]));
}

// ── Email reset helper ─────────────────────────────────────────────
async function sendResetEmail(email, resetUrl) {
  if (!process.env.SMTP_HOST || !nodemailer) return false;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: 'Звонок — сброс пароля',
    text: `Ссылка для сброса пароля:\n\n${resetUrl}\n\nСсылка действует 1 час.`,
    html: `<p>Ссылка для сброса пароля:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Ссылка действует 1 час.</p>`,
  });
  return true;
}

// ── Security headers ───────────────────────────────────────────────
app.use((req, res, next) => {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    "media-src blob:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '));
  next();
});

// ── Rate limiter ───────────────────────────────────────────────────
function makeRateLimiter(max, windowSec) {
  const hits = new Map();
  return (req, res, next) => {
    const ip  = req.ip || req.socket.remoteAddress || 'x';
    const now = Date.now();
    const win = windowSec * 1000;
    const ts  = (hits.get(ip) || []).filter(t => t > now - win);
    if (ts.length >= max)
      return res.status(429).json({ error: 'Слишком много попыток. Подожди немного.' });
    ts.push(now);
    hits.set(ip, ts);
    next();
  };
}
const limitAuth = makeRateLimiter(10, 60);

// ── Middleware ─────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Avatar upload ──────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => cb(null, req.user.id + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, f, cb) => cb(null, f.mimetype.startsWith('image/')),
});

// ═══════════════════════════════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════════════════════════════

// ── Auth ───────────────────────────────────────────────────────────
app.post('/api/register', limitAuth, async (req, res) => {
  try {
    const { username, password, name, email } = req.body || {};
    if (!username?.trim() || !password || !name?.trim())
      return res.status(400).json({ error: 'Заполни все поля' });
    if (username.trim().length < 3 || username.trim().length > 32)
      return res.status(400).json({ error: 'Логин — от 3 до 32 символов' });
    if (!/^[a-z0-9_]+$/i.test(username.trim()))
      return res.status(400).json({ error: 'Логин — только буквы, цифры и _' });
    if (name.trim().length > 64)
      return res.status(400).json({ error: 'Имя — максимум 64 символа' });
    if (password.length < 4 || password.length > 128)
      return res.status(400).json({ error: 'Пароль — от 4 до 128 символов' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Некорректный email' });
    const uname = username.trim().toLowerCase();
    if (await db.get('SELECT 1 FROM users WHERE username=?', [uname]))
      return res.status(400).json({ error: 'Логин уже занят' });
    if (email && await db.get('SELECT 1 FROM users WHERE email=?', [email.toLowerCase()]))
      return res.status(400).json({ error: 'Email уже используется' });
    const id = uuid();
    await db.run(
      'INSERT INTO users (id,username,pass_hash,name,avatar,email,created_at) VALUES(?,?,?,?,?,?,?)',
      [id, uname, bcrypt.hashSync(password, 10), name.trim(), 'default', email ? email.toLowerCase() : null, Date.now()]
    );
    const token = jwt.sign({ id, username: uname }, SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id, username: uname, name: name.trim(), avatar: 'default' } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/login', limitAuth, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const login = (username || '').toLowerCase().trim();
    const u = await db.get('SELECT * FROM users WHERE username=? OR email=?', [login, login]);
    if (!u || !bcrypt.compareSync(password || '', u.pass_hash))
      return res.status(400).json({ error: 'Неверный логин или пароль' });
    const token = jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: u.id, username: u.username, name: u.name, avatar: u.avatar } });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Password reset ─────────────────────────────────────────────────
app.post('/api/reset-request', limitAuth, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Введи email' });
    const u = await db.get('SELECT id,email FROM users WHERE email=?', [email.toLowerCase().trim()]);
    if (!u) return res.json({ ok: true, info: 'Если такой email зарегистрирован, ссылка отправлена.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 60 * 60 * 1000;
    await db.run('DELETE FROM password_resets WHERE user_id=?', [u.id]);
    await db.run('INSERT INTO password_resets VALUES(?,?,?)', [token, u.id, expires]);

    const host = req.headers.host || `localhost:${PORT}`;
    const resetUrl = `https://${host}/reset.html?token=${token}`;

    let emailSent = false;
    try { emailSent = await sendResetEmail(email, resetUrl); } catch {}

    if (emailSent) {
      res.json({ ok: true, info: 'Ссылка отправлена на почту.' });
    } else {
      console.log('\n  🔑 Ссылка для сброса пароля:', resetUrl, '\n');
      res.json({ ok: true, resetUrl, info: 'Email не настроен — ссылка выше.' });
    }
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Недостаточно данных' });
    if (password.length < 4 || password.length > 128)
      return res.status(400).json({ error: 'Пароль — от 4 до 128 символов' });
    const row = await db.get('SELECT * FROM password_resets WHERE token=?', [token]);
    if (!row) return res.status(400).json({ error: 'Ссылка недействительна' });
    if (Date.now() > row.expires_at) {
      await db.run('DELETE FROM password_resets WHERE token=?', [token]);
      return res.status(400).json({ error: 'Ссылка истекла' });
    }
    await db.run('UPDATE users SET pass_hash=? WHERE id=?', [bcrypt.hashSync(password, 10), row.user_id]);
    await db.run('DELETE FROM password_resets WHERE token=?', [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Me ─────────────────────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  try { res.json(await getUser(req.user.id)); }
  catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.patch('/api/me', auth, async (req, res) => {
  try {
    const { name, name_color, bio } = req.body || {};
    if (name?.trim()) {
      await db.run('UPDATE users SET name=? WHERE id=?', [name.trim(), req.user.id]);
      io.emit('user:update', { id: req.user.id, name: name.trim() });
    }
    if (name_color !== undefined) {
      await db.run('UPDATE users SET name_color=? WHERE id=?', [name_color || null, req.user.id]);
      io.emit('user:update', { id: req.user.id, name_color: name_color || null });
    }
    if (bio !== undefined) {
      await db.run('UPDATE users SET bio=? WHERE id=?', [bio || '', req.user.id]);
    }
    res.json(await getUser(req.user.id));
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/me/avatar', auth, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const avatar = '/uploads/' + req.file.filename;
    await db.run('UPDATE users SET avatar=? WHERE id=?', [avatar, req.user.id]);
    io.emit('user:update', { id: req.user.id, avatar });
    res.json({ avatar });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Users (search + profile) ───────────────────────────────────────
app.get('/api/users/search', auth, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (q.length < 2) return res.json([]);
    const users = await db.all(
      'SELECT id,username,name,avatar,name_color,bio FROM users WHERE username LIKE ? AND id!=? LIMIT 8',
      [`%${q}%`, req.user.id]
    );
    res.json(users);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/users/:id', auth, async (req, res) => {
  try {
    const u = await getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    const friendRow = await db.get(
      'SELECT status,from_id FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)',
      [req.user.id, req.params.id, req.params.id, req.user.id]
    );
    const blocked = await isBlocked(req.user.id, req.params.id);
    let friendStatus = 'none';
    if (friendRow) {
      if (friendRow.status === 'accepted') friendStatus = 'friends';
      else if (friendRow.from_id === req.user.id) friendStatus = 'sent';
      else friendStatus = 'received';
    }
    res.json({ ...u, friendStatus, blocked });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Rooms ──────────────────────────────────────────────────────────
app.get('/api/rooms', auth, async (req, res) => {
  try {
    const rows = await db.all(
      'SELECT r.* FROM rooms r JOIN members m ON r.id=m.room_id WHERE m.user_id=? ORDER BY r.created_at',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/rooms', auth, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'Нужно название' });
    if (name.trim().length > 64) return res.status(400).json({ error: 'Название — максимум 64 символа' });
    const id     = uuid();
    const invite = crypto.randomBytes(4).toString('hex').toUpperCase();
    await db.run('INSERT INTO rooms VALUES(?,?,?,?,?)', [id, name.trim(), req.user.id, invite, Date.now()]);
    await db.run('INSERT INTO members VALUES(?,?,?)', [id, req.user.id, Date.now()]);
    res.json(await db.get('SELECT * FROM rooms WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/rooms/join', auth, async (req, res) => {
  try {
    const { invite } = req.body || {};
    const room = await db.get('SELECT * FROM rooms WHERE invite=?', [(invite || '').toUpperCase().trim()]);
    if (!room) return res.status(404).json({ error: 'Комната не найдена' });
    await db.run('INSERT OR IGNORE INTO members VALUES(?,?,?)', [room.id, req.user.id, Date.now()]);
    const joinUser = await getUser(req.user.id);
    io.to(`room:${room.id}`).emit('room:joined', { roomId: room.id, user: joinUser });
    io.to(`room:${room.id}`).emit('sys:msg', { roomId: room.id, text: `${joinUser.name || joinUser.username} присоединился к серверу` });
    res.json(room);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/rooms/:id/messages', auth, async (req, res) => {
  try {
    if (!await isMember(req.params.id, req.user.id))
      return res.status(403).json({ error: 'Не участник' });
    const rows = await db.all(
      'SELECT m.*, u.name, u.avatar, u.username, u.name_color FROM messages m JOIN users u ON m.user_id=u.id WHERE m.room_id=? ORDER BY m.ts LIMIT 200',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/rooms/:id/members', auth, async (req, res) => {
  try {
    if (!await isMember(req.params.id, req.user.id))
      return res.status(403).json({ error: 'Не участник' });
    const rows = await db.all(
      'SELECT u.id, u.username, u.name, u.avatar, u.name_color FROM members mb JOIN users u ON mb.user_id=u.id WHERE mb.room_id=?',
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/rooms/:id/leave', auth, async (req, res) => {
  try {
    await db.run('DELETE FROM members WHERE room_id=? AND user_id=?', [req.params.id, req.user.id]);
    io.to(`room:${req.params.id}`).emit('room:left', { roomId: req.params.id, userId: req.user.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Friends ────────────────────────────────────────────────────────
app.get('/api/friends', auth, async (req, res) => {
  try {
    const friends = await db.all(`
      SELECT u.id,u.username,u.name,u.avatar,u.name_color FROM friends f
      JOIN users u ON f.to_id=u.id WHERE f.from_id=? AND f.status='accepted'
      UNION
      SELECT u.id,u.username,u.name,u.avatar,u.name_color FROM friends f
      JOIN users u ON f.from_id=u.id WHERE f.to_id=? AND f.status='accepted'
    `, [req.user.id, req.user.id]);
    const pending = await db.all(`
      SELECT u.id,u.username,u.name,u.avatar,u.name_color FROM friends f
      JOIN users u ON f.from_id=u.id WHERE f.to_id=? AND f.status='pending'
    `, [req.user.id]);
    res.json({ friends, pending });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/friends/add', auth, async (req, res) => {
  try {
    const { username } = req.body || {};
    const target = await db.get(
      'SELECT id,username,name,avatar FROM users WHERE username=?',
      [(username || '').toLowerCase().trim()]
    );
    if (!target)            return res.status(404).json({ error: 'Пользователь не найден' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'Нельзя добавить себя' });
    if (await isBlocked(req.user.id, target.id)) return res.status(400).json({ error: 'Пользователь заблокирован' });
    const exists = await db.get(
      'SELECT 1 FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)',
      [req.user.id, target.id, target.id, req.user.id]
    );
    if (exists) return res.status(400).json({ error: 'Заявка уже отправлена или вы уже друзья' });
    await db.run('INSERT INTO friends VALUES(?,?,?,?)', [req.user.id, target.id, 'pending', Date.now()]);
    const sock = onlineUsers.get(target.id);
    if (sock) io.to(sock).emit('friend:request', await getUser(req.user.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/friends/accept', auth, async (req, res) => {
  try {
    const { fromId } = req.body || {};
    const r = await db.run(`UPDATE friends SET status='accepted' WHERE from_id=? AND to_id=?`, [fromId, req.user.id]);
    if (!r.changes) return res.status(404).json({ error: 'Заявка не найдена' });
    const sock = onlineUsers.get(fromId);
    if (sock) io.to(sock).emit('friend:accepted', await getUser(req.user.id));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/friends/reject', auth, async (req, res) => {
  try {
    const { fromId } = req.body || {};
    await db.run('DELETE FROM friends WHERE from_id=? AND to_id=?', [fromId, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── Blocks ─────────────────────────────────────────────────────────
app.post('/api/users/:id/block', auth, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user.id) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
    await db.run('INSERT OR IGNORE INTO blocks VALUES(?,?,?)', [req.user.id, targetId, Date.now()]);
    await db.run(
      'DELETE FROM friends WHERE (from_id=? AND to_id=?) OR (from_id=? AND to_id=?)',
      [req.user.id, targetId, targetId, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.delete('/api/users/:id/block', auth, async (req, res) => {
  try {
    await db.run('DELETE FROM blocks WHERE blocker_id=? AND blocked_id=?', [req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── DM conversations list ───────────────────────────────────────
app.get('/api/dm/convos', auth, async (req, res) => {
  try {
    const me = req.user.id;
    const rows = await db.all(`
      SELECT u.id, u.name, u.username, u.avatar, u.name_color,
             MAX(m.ts) as last_ts,
             (SELECT content FROM dm_messages
              WHERE ((from_id=? AND to_id=u.id) OR (from_id=u.id AND to_id=?))
              ORDER BY ts DESC LIMIT 1) as last_msg
      FROM dm_messages m
      JOIN users u ON u.id = CASE WHEN m.from_id=? THEN m.to_id ELSE m.from_id END
      WHERE m.from_id=? OR m.to_id=?
      GROUP BY u.id
      ORDER BY last_ts DESC
    `, [me, me, me, me, me]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ── DM messages ────────────────────────────────────────────────────
app.get('/api/dm/:userId', auth, async (req, res) => {
  try {
    const otherId = req.params.userId;
    const msgs = await db.all(`
      SELECT m.*, u.name, u.avatar, u.username, u.name_color
      FROM dm_messages m JOIN users u ON m.from_id=u.id
      WHERE (m.from_id=? AND m.to_id=?) OR (m.from_id=? AND m.to_id=?)
      ORDER BY m.ts LIMIT 200
    `, [req.user.id, otherId, otherId, req.user.id]);
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ═══════════════════════════════════════════════════════════════════
// Socket.io
// ═══════════════════════════════════════════════════════════════════
const onlineUsers = new Map();
const voiceRooms  = new Map();
const userStatus  = new Map();

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token || '', SECRET);
    next();
  } catch {
    next(new Error('auth'));
  }
});

io.on('connection', async socket => {
  const uid = socket.user.id;
  onlineUsers.set(uid, socket.id);
  const savedStatus = userStatus.get(uid) || 'online';
  if (savedStatus !== 'invisible') {
    io.emit('presence', { userId: uid, online: true });
  }
  socket.emit('status:ack', savedStatus);

  try {
    const rooms = await db.all('SELECT room_id FROM members WHERE user_id=?', [uid]);
    rooms.forEach(({ room_id }) => socket.join(`room:${room_id}`));
  } catch {}

  // ── Chat ──────────────────────────────────────────────────────
  socket.on('msg', async ({ roomId, content }) => {
    try {
      if (!content?.trim() || content.length > 4000 || !await isMember(roomId, uid)) return;
      const id = uuid(), ts = Date.now();
      const u  = await getUser(uid);
      await db.run('INSERT INTO messages (id,room_id,user_id,content,ts) VALUES(?,?,?,?,?)', [id, roomId, uid, content.trim(), ts]);
      io.to(`room:${roomId}`).emit('msg', {
        id, room_id: roomId, user_id: uid,
        content: content.trim(), ts,
        name: u.name, avatar: u.avatar, username: u.username, name_color: u.name_color,
      });
    } catch {}
  });

  // ── DM ────────────────────────────────────────────────────────
  socket.on('dm:send', async ({ toId, content }) => {
    try {
      if (!content?.trim() || content.length > 4000) return;
      if (await isBlocked(uid, toId)) return;
      const id = uuid(), ts = Date.now();
      const u  = await getUser(uid);
      await db.run('INSERT INTO dm_messages VALUES(?,?,?,?,?)', [id, uid, toId, content.trim(), ts]);
      const msg = { id, from_id: uid, to_id: toId, content: content.trim(), ts, name: u.name, avatar: u.avatar, username: u.username, name_color: u.name_color };
      const recipSock = onlineUsers.get(toId);
      if (recipSock) io.to(recipSock).emit('dm:msg', msg);
      socket.emit('dm:msg', msg);
    } catch {}
  });

  // DM voice call
  socket.on('dm:ring', async ({ toId }) => {
    try {
      if (await isBlocked(uid, toId)) return;
      const targetSock = onlineUsers.get(toId);
      if (targetSock) io.to(targetSock).emit('dm:ring', { from: await getUser(uid) });
    } catch {}
  });

  socket.on('dm:ring:accept', async ({ toId }) => {
    try {
      const targetSock = onlineUsers.get(toId);
      if (targetSock) io.to(targetSock).emit('dm:ring:accepted', { from: await getUser(uid) });
    } catch {}
  });

  socket.on('dm:ring:decline', ({ toId }) => {
    const targetSock = onlineUsers.get(toId);
    if (targetSock) io.to(targetSock).emit('dm:ring:declined', { from: { id: uid } });
  });

  socket.on('room:socket:join', async (roomId) => {
    try {
      if (await isMember(roomId, uid)) socket.join(`room:${roomId}`);
    } catch {}
  });

  socket.on('voice:get', async (roomId) => {
    try {
      if (!await isMember(roomId, uid)) return;
      const room = voiceRooms.get(roomId);
      socket.emit('voice:state', { roomId, users: room ? [...room.keys()] : [] });
    } catch {}
  });

  socket.on('dm:ring:cancel', ({ toId }) => {
    const targetSock = onlineUsers.get(toId);
    if (targetSock) io.to(targetSock).emit('dm:ring:cancelled');
  });

  socket.on('dm:call:end', ({ toId }) => {
    const targetSock = onlineUsers.get(toId);
    if (targetSock) io.to(targetSock).emit('dm:call:ended', { fromId: uid });
  });

  // ── Voice signaling ───────────────────────────────────────────
  socket.on('voice:join', async ({ roomId }) => {
    try {
      if (roomId.startsWith('dm:')) {
        const parts = roomId.replace('dm:', '').split('_');
        if (!parts.includes(uid)) return;
      } else if (!await isMember(roomId, uid)) return;

      if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Map());
      const room     = voiceRooms.get(roomId);
      const existing = [...room.entries()].map(([userId, socketId]) => ({ userId, socketId }));
      room.set(uid, socket.id);
      socket.join(`voice:${roomId}`);
      socket.emit('voice:init', existing);
      socket.to(`voice:${roomId}`).emit('voice:joined', { userId: uid, socketId: socket.id });
      if (!roomId.startsWith('dm:')) {
        io.to(`room:${roomId}`).emit('voice:state', { roomId, users: [...room.keys()] });
      } else {
        io.to(`voice:${roomId}`).emit('voice:state', { roomId, users: [...room.keys()] });
      }
    } catch {}
  });

  socket.on('voice:leave', ({ roomId }) => voiceLeave(socket, uid, roomId));
  socket.on('voice:offer',  ({ to, offer })     => io.to(to).emit('voice:offer',  { from: socket.id, fromUser: uid, offer }));
  socket.on('voice:answer', ({ to, answer })    => io.to(to).emit('voice:answer', { from: socket.id, answer }));
  socket.on('voice:ice',    ({ to, candidate }) => io.to(to).emit('voice:ice',    { from: socket.id, candidate }));
  socket.on('voice:mute', ({ roomId, muted }) =>
    io.to(`voice:${roomId}`).emit('voice:mute', { userId: uid, muted }));

  socket.on('set:status', (status) => {
    if (!['online','dnd','invisible'].includes(status)) return;
    userStatus.set(uid, status);
    if (status === 'invisible') {
      io.emit('presence', { userId: uid, online: false });
    } else {
      io.emit('presence', { userId: uid, online: true });
      io.emit('user:status', { userId: uid, status });
    }
    socket.emit('status:ack', status);
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(uid);
    userStatus.delete(uid);
    io.emit('presence', { userId: uid, online: false });
    voiceRooms.forEach((_, roomId) => {
      if (voiceRooms.get(roomId)?.has(uid)) voiceLeave(socket, uid, roomId);
    });
  });
});

function voiceLeave(socket, uid, roomId) {
  const room = voiceRooms.get(roomId);
  if (!room?.has(uid)) return;
  room.delete(uid);
  socket.leave(`voice:${roomId}`);
  if (room.size === 0) voiceRooms.delete(roomId);
  io.to(`voice:${roomId}`).emit('voice:left', { userId: uid, socketId: socket.id });
  if (!roomId.startsWith('dm:')) {
    io.to(`room:${roomId}`).emit('voice:state', { roomId, users: [...(voiceRooms.get(roomId)?.keys() ?? [])] });
  } else {
    io.to(`voice:${roomId}`).emit('voice:state', { roomId, users: [...(voiceRooms.get(roomId)?.keys() ?? [])] });
  }
}

// ── Start ──────────────────────────────────────────────────────────
(async () => {
  await initDb();
  await db.exec(INIT_SQL);

  const migrateCol = async (table, col, def) => {
    try { await db.run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch {}
  };
  await migrateCol('users', 'email', 'TEXT');
  await migrateCol('users', 'name_color', 'TEXT');
  await migrateCol('users', 'bio', "TEXT DEFAULT ''");

  server.listen(PORT, '0.0.0.0', () => {
    if (IS_PROD) {
      console.log(`\n  Звонок запущен в production режиме на порту ${PORT}\n`);
    } else {
      const nets = Object.values(os.networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal);
      console.log('\n  ╔══════════════════════════════════════════╗');
      console.log('  ║    ⚡  Звонок v2.0  запущен (HTTPS)  ⚡  ║');
      console.log('  ╚══════════════════════════════════════════╝\n');
      console.log(`  Ты      :  https://localhost:${PORT}`);
      nets.forEach(n => console.log(`  Друг    :  https://${n.address}:${PORT}`));
      console.log('\n  ⚠  При первом входе нажми "Дополнительно" → "Перейти на сайт"\n');
    }
  });
})();

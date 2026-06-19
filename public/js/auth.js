'use strict';

if (localStorage.getItem('zvonok_token')) location.href = '/app.html';

const $ = id => document.getElementById(id);

// ── Tabs ──────────────────────────────────────────────────────────
$('tab-login').addEventListener('click', () => switchTab('login'));
$('tab-reg').addEventListener('click',   () => switchTab('reg'));

function switchTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-reg').classList.toggle('active',   tab === 'reg');
  $('form-login').classList.toggle('hidden', tab !== 'login');
  $('form-reg').classList.toggle('hidden',   tab !== 'reg');
  $('form-forgot').classList.add('hidden');
  $('err-login').textContent = '';
  $('err-reg').textContent   = '';
}

$('btn-forgot').addEventListener('click', () => {
  $('form-login').classList.add('hidden');
  $('form-forgot').classList.remove('hidden');
  $('err-forgot').textContent = '';
  $('ok-forgot').style.display = 'none';
  $('ok-forgot').textContent = '';
});

$('btn-back-login').addEventListener('click', () => {
  $('form-forgot').classList.add('hidden');
  $('form-login').classList.remove('hidden');
});

// ── Login ─────────────────────────────────────────────────────────
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('err-login');
  const fd  = new FormData(e.target);
  err.textContent = '';
  btn.textContent = '...';
  btn.disabled    = true;
  try {
    const res  = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error; return; }
    localStorage.setItem('zvonok_token', data.token);
    localStorage.setItem('zvonok_user',  JSON.stringify(data.user));
    location.href = '/app.html';
  } catch {
    err.textContent = 'Ошибка соединения';
  } finally {
    btn.textContent = 'Войти ▶';
    btn.disabled    = false;
  }
});

// ── Register ──────────────────────────────────────────────────────
$('form-reg').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('err-reg');
  const fd  = new FormData(e.target);
  err.textContent = '';
  btn.textContent = '...';
  btn.disabled    = true;
  try {
    const res  = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: fd.get('username'),
        password: fd.get('password'),
        name:     fd.get('name'),
        email:    fd.get('email') || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error; return; }
    localStorage.setItem('zvonok_token', data.token);
    localStorage.setItem('zvonok_user',  JSON.stringify(data.user));
    location.href = '/app.html';
  } catch {
    err.textContent = 'Ошибка соединения';
  } finally {
    btn.textContent = 'Создать аккаунт ▶';
    btn.disabled    = false;
  }
});

// ── Forgot password ───────────────────────────────────────────────
$('form-forgot').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type=submit]');
  const err = $('err-forgot');
  const ok  = $('ok-forgot');
  const fd  = new FormData(e.target);
  err.textContent = '';
  ok.style.display = 'none';
  btn.textContent = '...';
  btn.disabled = true;
  try {
    const res  = await fetch('/api/reset-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: fd.get('email') }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.error; return; }
    ok.style.display = 'block';
    if (data.resetUrl) {
      ok.innerHTML = `Ссылка для сброса:<br><a href="${data.resetUrl}" style="color:var(--accent);word-break:break-all">${data.resetUrl}</a>`;
    } else {
      ok.textContent = data.info || 'Ссылка отправлена!';
    }
  } catch {
    err.textContent = 'Ошибка соединения';
  } finally {
    btn.textContent = 'Отправить ссылку';
    btn.disabled = false;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const current = $('tab-login').classList.contains('active') ? 'login' : 'reg';
    switchTab(current === 'login' ? 'reg' : 'login');
  }
});

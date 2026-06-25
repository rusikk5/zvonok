'use strict';
// Minimal PWA service worker — enables install + offline shell, never touches live data.
const CACHE = 'zvonok-v3';
const SHELL = ['/app.html', '/index.html', '/css/app.css', '/js/main.js', '/js/voice.js', '/js/auth.js', '/icon.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;                       // never touch POST/socket writes
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;                 // external (STUN/etc) — leave alone
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/socket.io/') ||
      url.pathname.startsWith('/uploads/')) return;           // live data — always network

  // Network-first, fall back to cache (so the app shell still opens offline)
  e.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(request, copy)); }
        return res;
      })
      .catch(() => caches.match(request).then((c) => c || caches.match('/app.html')))
  );
});

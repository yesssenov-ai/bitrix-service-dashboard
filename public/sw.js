/* ProLabSupport ЦУП — service worker (устанавливаемое приложение / PWA).
   Стратегия безопасная:
   • /api/, /login, /logout — ВСЕГДА сеть, ничего не кэшируем (данные и авторизация свежие);
   • переходы по страницам — сеть, при офлайне отдаём кэш (или портал);
   • CSS/JS/манифест — СНАЧАЛА СЕТЬ (после деплоя сразу свежие; кэш — только офлайн-фолбэк);
   • картинки/шрифты — cache-first (они меняются редко). */
const CACHE = 'pls-cup-v3';
const SHELL = ['/portal.html', '/login.html', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/login') || p.startsWith('/logout')) return; // всегда сеть
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp).catch(() => {})); return r; })
        .catch(() => caches.match(req).then(m => m || caches.match('/portal.html')))
    );
    return;
  }
  // CSS/JS/манифест — network-first: гарантирует свежие стили и скрипты после деплоя.
  if (/\.(css|js|webmanifest)$/i.test(p)) {
    e.respondWith(
      fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp).catch(() => {})); return r; })
        .catch(() => caches.match(req))
    );
    return;
  }
  // Картинки/шрифты — cache-first с фоновым обновлением.
  if (/\.(png|jpe?g|svg|ico|woff2?|ttf)$/i.test(p)) {
    e.respondWith(
      caches.match(req).then(m => m || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp).catch(() => {})); return r; }))
    );
  }
});

// ── Бейдж на иконке приложения ──────────────────────────────────────────────
// Обновляет число невыполненных действий пользователя. Вызывается:
//  • фоново — Periodic Background Sync (Chromium, установленное PWA);
//  • по запросу страницы — postMessage({type:'update-badge'}).
function setBadge(n) {
  try {
    n = Number(n) || 0;
    if (n > 0 && self.navigator && navigator.setAppBadge) return navigator.setAppBadge(n);
    if (navigator.clearAppBadge) return navigator.clearAppBadge();
  } catch (e) { /* игнор */ }
}
function updateBadge() {
  return fetch('/api/notify/pending-count', { credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => { if (d) setBadge(d.count); })
    .catch(() => {});
}
self.addEventListener('periodicsync', e => { if (e.tag === 'pls-badge') e.waitUntil(updateBadge()); });
self.addEventListener('message', e => { if (e.data && e.data.type === 'update-badge') { e.waitUntil ? e.waitUntil(updateBadge()) : updateBadge(); } });

// Пуш от сервера: {type:'badge'|'alert', count?, notify?:{title,body}, url?}
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = {}; }
  const tasks = [];
  // Обновить бейдж: из payload (count) либо перезапросить актуальное число.
  if (typeof data.count === 'number') tasks.push(Promise.resolve(setBadge(data.count)));
  else tasks.push(updateBadge());
  // Показать всплывающее уведомление, если сервер попросил.
  if (data.notify && data.notify.title) {
    tasks.push(self.registration.showNotification(data.notify.title, {
      body: data.notify.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag || 'pls-cup',
      renotify: true,
      data: { url: data.url || '/portal.html' },
    }));
  }
  e.waitUntil(Promise.all(tasks));
});

// Клик по уведомлению — открыть/сфокусировать приложение на нужной странице.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/portal.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if ('focus' in c) { c.navigate && c.navigate(url); return c.focus(); } }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

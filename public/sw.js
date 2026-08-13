/* ProLabSupport ЦУП — service worker (устанавливаемое приложение / PWA).
   Стратегия безопасная:
   • /api/, /login, /logout — ВСЕГДА сеть, ничего не кэшируем (данные и авторизация свежие);
   • переходы по страницам — сеть, при офлайне отдаём кэш (или портал);
   • статика (иконки, шрифты, css/js) — cache-first с фоновым обновлением. */
const CACHE = 'pls-cup-v1';
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
  if (/\.(png|jpe?g|svg|ico|css|js|woff2?|ttf|webmanifest)$/i.test(p)) {
    e.respondWith(
      caches.match(req).then(m => m || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp).catch(() => {})); return r; }))
    );
  }
});

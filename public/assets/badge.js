/* ProLabSupport ЦУП — бейдж на иконке приложения + подписка на пуши.
   Бейдж (App Badging API) показывает число действий, за которые отвечает вошедший
   пользователь по ВСЕМ модулям (согласования, оплаты, приёмка, задачи Bitrix).
   • Приложение открыто/свёрнуто → опрос раз в минуту + при фокусе.
   • Установленное приложение + разрешение на уведомления → Web Push: бейдж и
     уведомления приходят, даже когда приложение закрыто. */
(function () {
  var POLL = 60000, timer = null, last = -1;
  var badgeOK = ('setAppBadge' in navigator);

  function apply(n) {
    if (!badgeOK) return;
    n = Number(n) || 0;
    if (n === last) return;
    last = n;
    try {
      if (n > 0) navigator.setAppBadge(n).catch(function () {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {});
    } catch (e) { /* игнор */ }
  }

  function refresh() {
    return fetch('/api/notify/pending-count', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (d) { apply((d && d.count) || 0); })
      .catch(function () { /* не залогинен / офлайн — бейдж не трогаем */ });
  }

  function startPolling() {
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(function () { if (document.visibilityState !== 'hidden') refresh(); }, POLL);
  }

  // ── Web Push подписка ──────────────────────────────────────────────────────
  function urlB64ToUint8Array(base64) {
    var pad = '='.repeat((4 - base64.length % 4) % 4);
    var b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(b64), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
    fetch('/api/notify/push-key', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.enabled || !info.key) return;
        var doSub = function () {
          navigator.serviceWorker.ready.then(function (reg) {
            reg.pushManager.getSubscription().then(function (existing) {
              var p = existing ? Promise.resolve(existing)
                : reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(info.key) });
              p.then(function (sub) {
                fetch('/api/notify/subscribe', {
                  method: 'POST', credentials: 'same-origin',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ subscription: sub })
                }).catch(function () {});
              }).catch(function () {});
            });
          });
        };
        if (Notification.permission === 'granted') doSub();
        else {
          // Просим разрешение. Если браузер требует жест — повесим на первый клик.
          var ask = function () {
            Notification.requestPermission().then(function (p) { if (p === 'granted') doSub(); });
            window.removeEventListener('click', ask);
          };
          Notification.requestPermission().then(function (p) {
            if (p === 'granted') doSub();
            else if (p === 'default') window.addEventListener('click', ask, { once: true });
          }).catch(function () { window.addEventListener('click', ask, { once: true }); });
        }
      }).catch(function () {});
  }

  function start() {
    startPolling();
    subscribePush();
    // Фоновое обновление бейджа (Chromium + установленное PWA).
    if ('serviceWorker' in navigator && 'periodicSync' in ServiceWorkerRegistration.prototype) {
      navigator.serviceWorker.ready.then(function (reg) {
        var q = navigator.permissions ? navigator.permissions.query({ name: 'periodic-background-sync' }) : Promise.resolve({ state: 'granted' });
        q.then(function (st) {
          if (st.state === 'granted') reg.periodicSync.register('pls-badge', { minInterval: 30 * 60 * 1000 }).catch(function () {});
        }).catch(function () {});
      }).catch(function () {});
    }
  }

  if (document.readyState === 'complete') start();
  else addEventListener('load', start);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
})();

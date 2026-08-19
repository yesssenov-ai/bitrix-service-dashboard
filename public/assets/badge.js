/* ProLabSupport ЦУП — бейдж на иконке приложения + подписка на пуши.
   Бейдж (App Badging API) показывает число действий, за которые отвечает вошедший
   пользователь по ВСЕМ модулям (согласования, оплаты, приёмка, задачи Bitrix).
   • Приложение открыто/свёрнуто → опрос раз в минуту + при фокусе.
   • Установленное приложение + разрешение на уведомления → Web Push: бейдж и
     уведомления приходят, даже когда приложение закрыто.

   ВАЖНО про iPhone/iOS: запрос разрешения на уведомления показывается ТОЛЬКО в
   ответ на касание пользователя (по правилам Safari). Поэтому здесь мы НЕ просим
   разрешение автоматически на загрузке — показываем кнопку «Включить уведомления»,
   и запрос уходит уже по нажатию. На десктопе кнопка работает так же. */
(function () {
  var POLL = 60000, timer = null, last = -1;
  var badgeOK = ('setAppBadge' in navigator);
  var pushOK = ('serviceWorker' in navigator) && ('PushManager' in window) && (typeof Notification !== 'undefined');
  var vapidKey = null, keyChecked = false;

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

  // Оформить подписку (разрешение уже granted). Возвращает Promise.
  function doSubscribe() {
    if (!vapidKey) return Promise.resolve(false);
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        var p = existing ? Promise.resolve(existing)
          : reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidKey) });
        return p.then(function (sub) {
          return fetch('/api/notify/subscribe', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub })
          }).then(function () { return true; });
        });
      });
    }).catch(function () { return false; });
  }

  // Плавающая кнопка «Включить уведомления» — показываем, если пуши поддерживаются,
  // ключ есть, а разрешение ещё не выдано. Запрос — строго по нажатию (нужно для iOS).
  function showEnableButton() {
    if (document.getElementById('pls-notify-btn')) return;
    if (Notification.permission === 'granted') return;
    try { if (sessionStorage.getItem('pls-notify-dismissed') === '1') return; } catch (e) {}
    var b = document.createElement('button');
    b.id = 'pls-notify-btn';
    b.type = 'button';
    b.innerHTML = '🔔 Включить уведомления';
    b.setAttribute('style', [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:99999',
      'background:#0f6cbd', 'color:#fff', 'border:none', 'border-radius:24px',
      'padding:11px 16px', 'font:600 14px Inter,Arial,sans-serif',
      'box-shadow:0 6px 20px rgba(0,0,0,.28)', 'cursor:pointer', 'max-width:calc(100vw - 32px)'
    ].join(';'));
    var close = document.createElement('span');
    close.innerHTML = ' ✕';
    close.setAttribute('style', 'margin-left:8px;opacity:.7');
    close.addEventListener('click', function (ev) {
      ev.stopPropagation();
      try { sessionStorage.setItem('pls-notify-dismissed', '1'); } catch (e) {}
      b.remove();
    });
    b.appendChild(close);
    b.addEventListener('click', function () {
      if (Notification.permission === 'denied') {
        alert('Уведомления отключены в настройках телефона.\n\niPhone: Настройки → Уведомления → ЦУП → включить «Допуск уведомлений».\n\nЕсли приложения нет в списке — открой ЦУП с домашнего экрана и попробуй снова.');
        return;
      }
      // Запрос разрешения ВНУТРИ обработчика нажатия (обязательно для iOS).
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') {
          b.remove();
          doSubscribe();
          refresh();
        } else if (p === 'denied') {
          b.remove();
          try { sessionStorage.setItem('pls-notify-dismissed', '1'); } catch (e) {}
        }
      }).catch(function () {});
    });
    (document.body || document.documentElement).appendChild(b);
  }

  // Проверяем, включены ли пуши на сервере, и решаем: подписаться молча (если уже
  // granted) или показать кнопку включения.
  function setupPush() {
    if (!pushOK || keyChecked) return;
    keyChecked = true;
    fetch('/api/notify/push-key', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info || !info.enabled || !info.key) return; // сервер без ключей — пуши недоступны
        vapidKey = info.key;
        if (Notification.permission === 'granted') doSubscribe();
        else if (Notification.permission === 'default') showEnableButton();
        // denied — кнопку тоже показываем: по нажатию подскажем, как включить в настройках.
        else showEnableButton();
      }).catch(function () { /* не залогинен — молчим */ });
  }

  function start() {
    startPolling();
    setupPush();
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

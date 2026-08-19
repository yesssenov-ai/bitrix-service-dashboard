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

  // Стиль кнопки в дизайн-системе ЦУП (чёткая линия, teal-акцент, аккуратный ховер).
  // Внедряем один раз — так доступны :hover и media-запросы.
  function injectFabStyle() {
    if (document.getElementById('pls-fab-style')) return;
    var css = ''
      + '.pls-fab{position:fixed;right:18px;bottom:70px;z-index:99998;display:inline-flex;align-items:center;gap:9px;'
      + 'background:var(--panel,#1b1f27);color:var(--text,#eef0f3);border:1px solid var(--line-2,#363c49);'
      + 'border-radius:12px;padding:10px 13px;font:600 13px "Inter",system-ui,-apple-system,sans-serif;letter-spacing:.2px;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,.30);cursor:pointer;'
      + 'transition:border-color .15s ease,transform .15s ease,background .2s ease;animation:plsFabIn .25s ease both;}'
      + '.pls-fab:hover{border-color:var(--signal,#35d0c0);transform:translateY(-1px);}'
      + '.pls-fab:focus-visible{outline:2px solid var(--signal,#35d0c0);outline-offset:2px;}'
      + '.pls-fab .ic{color:var(--signal,#35d0c0);display:flex;flex:none;}'
      + '.pls-fab .x{margin-left:3px;color:var(--text-faint,#565d6b);font-weight:400;font-size:15px;line-height:1;padding:1px 3px;border-radius:6px;}'
      + '.pls-fab .x:hover{color:var(--text,#eef0f3);background:rgba(255,255,255,.06);}'
      + '@keyframes plsFabIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}'
      + '@media(max-width:520px){.pls-fab{right:12px;bottom:64px;}}';
    var st = document.createElement('style');
    st.id = 'pls-fab-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }

  // Плавающая кнопка «Включить уведомления» — показываем, если пуши поддерживаются,
  // ключ есть, а разрешение ещё не выдано. Запрос — строго по нажатию (нужно для iOS).
  function showEnableButton() {
    if (document.getElementById('pls-notify-btn')) return;
    if (Notification.permission === 'granted') return;
    try { if (sessionStorage.getItem('pls-notify-dismissed') === '1') return; } catch (e) {}
    injectFabStyle();
    var b = document.createElement('button');
    b.id = 'pls-notify-btn';
    b.type = 'button';
    b.className = 'pls-fab';
    b.setAttribute('aria-label', 'Включить уведомления');
    var bell = '<span class="ic"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 1 1 12 0c0 4.5 1.8 5.7 2.4 6.2a.5.5 0 0 1-.3.8H3.9a.5.5 0 0 1-.3-.8C4.2 14.7 6 13.5 6 9Z"/><path d="M10.3 20a1.9 1.9 0 0 0 3.4 0"/></svg></span>';
    b.innerHTML = bell + '<span>Включить уведомления</span>';
    var close = document.createElement('span');
    close.className = 'x';
    close.innerHTML = '✕';
    close.setAttribute('aria-label', 'Скрыть');
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

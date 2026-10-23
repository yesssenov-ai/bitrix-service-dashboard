/* Плашка режима «Вход от имени».
   Показывается на каждой странице, если текущая сессия — это суперадмин,
   вошедший от имени сотрудника (/auth/me вернул impersonatedBy).
   Даёт заметную полосу сверху и кнопку «Вернуться к себе». */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }

  async function init() {
    try {
      const r = await fetch('/auth/me', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      if (!d || !d.impersonatedBy) return;      // обычная сессия — ничего не показываем
      render(d.user, d.impersonatedBy);
    } catch (e) { /* молча — плашка не критична */ }
  }

  function render(user, by) {
    if (document.getElementById('imp-bar')) return;
    const bar = document.createElement('div');
    bar.id = 'imp-bar';
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483646',
      'background:#b45309', 'color:#fff', 'font:600 13px/1.3 -apple-system,Segoe UI,Roboto,sans-serif',
      'padding:8px 14px', 'display:flex', 'align-items:center', 'gap:12px',
      'box-shadow:0 2px 10px rgba(0,0,0,.25)', 'flex-wrap:wrap'
    ].join(';');
    const uname = esc((user && user.displayName) || 'сотрудника');
    const byname = esc((by && by.name) || 'Суперадмин');
    bar.innerHTML =
      '<span style="font-size:15px">👁</span>' +
      '<span>Вы вошли от имени <b>' + uname + '</b> · режим суперадмина (' + byname + ')</span>' +
      '<button id="imp-exit" style="margin-left:auto;background:#fff;color:#b45309;border:0;border-radius:6px;' +
      'padding:6px 12px;font:600 13px/1 inherit;cursor:pointer">← Вернуться к себе</button>';
    (document.body || document.documentElement).appendChild(bar);

    // Сдвигаем контент вниз, чтобы полоса ничего не перекрывала.
    try {
      const h = bar.offsetHeight || 38;
      document.documentElement.style.scrollPaddingTop = h + 'px';
      document.body.style.paddingTop = h + 'px';
    } catch (e) {}

    document.getElementById('imp-exit').addEventListener('click', async function () {
      this.disabled = true; this.textContent = 'Возврат…';
      try {
        const resp = await fetch('/auth/stop-impersonate', { method: 'POST', credentials: 'same-origin' });
        const j = await resp.json().catch(function () { return {}; });
        if (resp.ok && j.ok) { location.href = '/'; return; }
        location.href = (j && j.redirect) || '/login.html';
      } catch (e) { location.href = '/login.html'; }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/* cup-mobile.js — мобильный app-shell ЦУП: нижняя навигация + лист быстрых
   действий. Подставляется сервером на все страницы дизайн-системы. Виден только
   на узких экранах (≤640px, см. .cup-mobnav в cup-ui.css). Строгие line-иконки. */
(function () {
  if (window.__cupMobile) return; window.__cupMobile = 1;

  var SVG = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
    check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20v-1a7 7 0 0 1 14 0v1"/>',
    bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M8.5 14h.01M15.5 14h.01"/>',
    help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.6M12 17h.01"/>',
    msg: '<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'
  };
  function svg(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (SVG[n] || '') + '</svg>'; }
  function clickId(id) { var e = document.getElementById(id); if (e) { e.click(); return true; } return false; }
  function go(h) { location.href = h; }
  function openSearch() { if (!clickId('pls-sr-btn')) go('/portal.html'); }

  var path = (location.pathname || '/').replace(/\/+$/, '') || '/';
  var isHome = (path === '' || path === '/' || /\/portal\.html$/.test(path));
  var isTasks = /\/board\.html$/.test(path);

  var sheet = null;
  function closeSheet() { if (sheet) { sheet.remove(); sheet = null; } }
  function openSheet(title, items) {
    closeSheet();
    sheet = document.createElement('div'); sheet.className = 'cup-mobsheet';
    sheet.innerHTML = '<div class="cup-mobsheet-bd"></div><div class="cup-mobsheet-card">' +
      '<div class="cup-mobsheet-grip"></div><div class="cup-mobsheet-t">' + title + '</div>' +
      '<div class="cup-mobsheet-items"></div></div>';
    var box = sheet.querySelector('.cup-mobsheet-items');
    items.forEach(function (it) {
      var b = document.createElement('button'); b.className = 'cup-mobsheet-i';
      b.innerHTML = svg(it.i) + '<span>' + it.t + '</span>';
      b.onclick = function () { closeSheet(); setTimeout(it.fn, 10); };
      box.appendChild(b);
    });
    sheet.querySelector('.cup-mobsheet-bd').onclick = closeSheet;
    document.body.appendChild(sheet);
  }

  function build() {
    if (document.getElementById('cupMobNav')) return;
    var nav = document.createElement('nav'); nav.id = 'cupMobNav'; nav.className = 'cup-mobnav';
    function tab(n, label, active) {
      return '<a href="javascript:void(0)" class="' + (active ? 'on' : '') + '">' + svg(n) + '<span>' + label + '</span></a>';
    }
    nav.innerHTML =
      tab('home', 'Главная', isHome) +
      tab('check', 'Задачи', isTasks) +
      '<a href="javascript:void(0)" class="fabwrap"><span class="fab">' + svg('plus') + '</span></a>' +
      tab('search', 'Поиск', false) +
      tab('menu', 'Ещё', false);
    document.body.appendChild(nav);
    var a = nav.querySelectorAll('a');
    a[0].onclick = function () { go('/portal.html'); };
    a[1].onclick = function () { go('/board.html'); };
    a[2].onclick = function () {
      openSheet('Быстрые действия', [
        { i: 'search', t: 'Поиск', fn: openSearch },
        { i: 'check', t: 'Мои задачи', fn: function () { go('/board.html'); } },
        { i: 'grid', t: 'Все модули', fn: function () { go('/portal.html'); } },
        { i: 'bot', t: 'Ассистент', fn: function () { clickId('pai-fab'); } }
      ]);
    };
    a[3].onclick = openSearch;
    a[4].onclick = function () {
      openSheet('Ещё', [
        { i: 'user', t: 'Личный кабинет', fn: function () { go('/account.html'); } },
        { i: 'bot', t: 'Ассистент', fn: function () { clickId('pai-fab'); } },
        { i: 'help', t: 'Помощь', fn: function () { clickId('pls-help-btn'); } },
        { i: 'msg', t: 'Обратная связь', fn: function () { clickId('pls-fb-btn'); } }
      ]);
    };
  }

  if (document.body) build();
  else document.addEventListener('DOMContentLoaded', build);
})();

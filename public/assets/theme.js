/* Плавающий переключатель светлой/тёмной темы. Значение хранится в localStorage
   (pls-theme = 'light' | 'dark') и применяется на всех страницах дашборда.
   Предварительная установка атрибута делается инлайн-скриптом в <head>
   (чтобы не мигало), здесь — только кнопка и переключение. */
(function () {
  var KEY = 'pls-theme';
  // Строгие линейные иконки (feather-стиль). Показываем ту, куда переключимся:
  // в светлой теме — месяц (перейти в тёмную), в тёмной — солнце (перейти в светлую).
  var SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.2M12 19.2v2.2M4.5 4.5l1.6 1.6M17.9 17.9l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.5 19.5l1.6-1.6M17.9 6.1l1.6-1.6"/></svg>';
  var MOON = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 13.2A8 8 0 1 1 10.8 3.5a6.3 6.3 0 0 0 9.7 9.7z"/></svg>';
  function current() {
    try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch (e) { return 'dark'; }
  }
  function apply(mode) {
    if (mode === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'light' ? '#f3f5f9' : '#14171d');
    var btn = document.getElementById('themeToggle');
    if (btn) {
      btn.innerHTML = mode === 'light' ? MOON : SUN;
      btn.title = mode === 'light' ? 'Тёмная тема' : 'Светлая тема';
      btn.setAttribute('aria-label', btn.title);
    }
  }
  function toggle() {
    var next = current() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  }
  function mount() {
    if (document.getElementById('themeToggle')) return;
    var btn = document.createElement('button');
    btn.id = 'themeToggle';
    btn.type = 'button';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);
    apply(current());
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();

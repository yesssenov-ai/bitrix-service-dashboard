/* Плавающий переключатель светлой/тёмной темы. Значение хранится в localStorage
   (pls-theme = 'light' | 'dark') и применяется на всех страницах дашборда.
   Предварительная установка атрибута делается инлайн-скриптом в <head>
   (чтобы не мигало), здесь — только кнопка и переключение. */
(function () {
  var KEY = 'pls-theme';
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
      btn.textContent = mode === 'light' ? '🌙' : '☀️';
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

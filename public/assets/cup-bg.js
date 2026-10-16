// Фирменный фон-орнамент (ою). Добавляет один фиксированный слой #cup-bg первым
// элементом <body> на каждой странице. Стили и тема-зависимые картинки — в
// cup-ui.css (#cup-bg). Слой за контентом (z-index:-1), клики не ловит.
// Идемпотентно: если слой уже есть — ничего не делает.
(function () {
  function add() {
    try {
      if (!document.body || document.getElementById('cup-bg')) return;
      var d = document.createElement('div');
      d.id = 'cup-bg';
      d.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(d, document.body.firstChild);
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
  else add();
})();

/* Переиспользуемый индикатор прогресса фоновой синхронизации.
   Использование:
     SyncBar.run({
       startUrl:'/api/<module>/resync',      // POST — запускает фоновый синк
       statusUrl:'/api/<module>/resync-status', // GET — {busy, progress:{phase,total,done,errors,pct,etaSec}}
       button: document.getElementById('resyncBtn'), // необязательно (блокируем/восстанавливаем)
       mount: '.wrap',                        // куда вставить плашку (селектор/элемент; по умолчанию .wrap → body)
       confirm: 'Запустить…?',                // необязательный confirm перед стартом
       onDone: function(){ location.reload(); } // что сделать по завершении
     });
   Прогресс показывается в процентах, если бэкенд отдаёт total; иначе — «идёт…»
   (неопределённый бар). Работает на любой странице без зависимостей от CSS. */
(function () {
  'use strict';
  var PHASE = { count: 'Подсчёт в Bitrix…', sync: 'Загрузка и обновление…', done: 'Готово', idle: 'Запуск…' };
  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  function fmtEta(s) { if (s == null) return ''; if (s < 60) return s + ' сек'; var m = Math.floor(s / 60), ss = s % 60; return m + ' мин' + (ss ? ' ' + ss + ' сек' : ''); }

  function ensureKeyframes() {
    if (document.getElementById('sb-kf')) return;
    var s = el('style'); s.id = 'sb-kf';
    s.textContent = '@keyframes sb-indet{0%{transform:translateX(-120%)}100%{transform:translateX(320%)}}';
    document.head.appendChild(s);
  }
  function makePanel() {
    ensureKeyframes();
    var p = el('div', 'margin:0 0 12px;padding:14px 16px;border:1px solid var(--line,#e7eaf0);border-radius:14px;background:var(--surface,#fff);color:var(--text,#101624);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif');
    p.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<b class="sb-title">Синхронизация…</b>' +
        '<span class="sb-info" style="font-size:11.5px;color:var(--text-3,#6a7488)"></span>' +
        '<span style="flex:1"></span>' +
        '<span class="sb-pct" style="font-weight:800;font-variant-numeric:tabular-nums"></span>' +
      '</div>' +
      '<div style="height:9px;background:var(--surface-2,#f1f3f6);border:1px solid var(--line,#e7eaf0);border-radius:6px;overflow:hidden;margin-top:8px">' +
        '<div class="sb-fill" style="height:100%;width:0;background:var(--accent,#C53B2F);transition:width .4s"></div>' +
      '</div>';
    return p;
  }
  function render(panel, p, busy) {
    var indet = !p.total, pct = p.pct || 0, fill = panel.querySelector('.sb-fill');
    panel.querySelector('.sb-title').textContent = PHASE[p.phase] || 'Синхронизация…';
    panel.querySelector('.sb-pct').textContent = indet ? '' : (pct + '%');
    if (indet && busy) { fill.style.width = '30%'; fill.style.animation = 'sb-indet 1.1s ease-in-out infinite'; }
    else { fill.style.animation = ''; fill.style.width = (busy ? pct : 100) + '%'; }
    var info = '';
    if (p.total) info = 'обработано ' + p.done + ' из ' + p.total + (p.errors ? ' · ошибок ' + p.errors : '') + (p.etaSec ? ' · осталось ~' + fmtEta(p.etaSec) : '');
    else if (p.done) info = 'обработано ' + p.done;
    else info = busy ? 'идёт…' : '';
    panel.querySelector('.sb-info').textContent = info;
  }

  window.SyncBar = {
    run: function (opts) {
      opts = opts || {};
      if (opts.confirm && !window.confirm(opts.confirm)) return;
      var btn = opts.button, origText = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Синхронизация…'; }
      var mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
      mount = mount || document.querySelector('.wrap') || document.body;
      var panel = makePanel();
      mount.insertBefore(panel, mount.firstChild);
      function restore() { if (btn) { btn.disabled = false; btn.textContent = origText; } }
      function finishUi(p) {
        panel.querySelector('.sb-title').textContent = 'Готово ✓';
        var fill = panel.querySelector('.sb-fill'); fill.style.animation = ''; fill.style.width = '100%';
        panel.querySelector('.sb-pct').textContent = p.total ? '100%' : '';
        panel.querySelector('.sb-info').textContent = 'обновлено ' + (p.done || 0) + (p.errors ? ' · ошибок ' + p.errors : '');
      }
      var fails = 0;
      function poll() {
        fetch(opts.statusUrl, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
          var ct = r.headers.get('content-type') || '';
          if (!r.ok || ct.indexOf('json') < 0) throw new Error('not-json'); // сервер перезапускается / роут не поднят
          return r.json();
        }).then(function (d) {
          fails = 0;
          var p = (d && d.progress) || {}, busy = !!(d && (d.busy || p.running));
          render(panel, p, busy);
          if (busy) { setTimeout(poll, 1500); }
          else { finishUi(p); restore(); setTimeout(function () { panel.remove(); }, 6000); if (opts.onDone) try { opts.onDone(); } catch (e) {} }
        }).catch(function () {
          // Транзиентно (перезапуск после деплоя / статус-роут ещё не поднялся): синк идёт
          // на сервере — не пугаем, пробуем несколько раз, потом спокойно просим обновить.
          fails++;
          if (fails < 6) { panel.querySelector('.sb-title').textContent = 'Синхронизация идёт…'; panel.querySelector('.sb-info').textContent = 'ждём ответ сервера…'; setTimeout(poll, 1500); }
          else { panel.querySelector('.sb-title').textContent = 'Синхронизация идёт на сервере'; panel.querySelector('.sb-info').textContent = 'Статус пока недоступен — обновите страницу через пару минут.'; restore(); }
        });
      }
      fetch(opts.startUrl, { method: 'POST', credentials: 'same-origin' }).then(function (r) {
        if (r.status === 403) { alert('Только для администратора.'); restore(); panel.remove(); return null; }
        return r.json().catch(function () { return {}; });
      }).then(function (d) { if (d === null) return; poll(); })
        .catch(function (e) { alert('Ошибка запуска: ' + e.message); restore(); panel.remove(); });
    }
  };
})();

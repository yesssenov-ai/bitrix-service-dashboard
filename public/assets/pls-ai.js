/* ProLab AI — плавающая «умная строка» снизу справа. Подключается одним тегом
   <script src="/assets/pls-ai.js" defer></script> на любой странице ЦУП.
   v1: разбор запроса по ключевым словам на сервере (/api/plsai) + выгрузка в Excel. */
(function () {
  if (window.__prolabAI) return; window.__prolabAI = true;
  var css = `
  #pai-fab{position:fixed;right:18px;bottom:18px;z-index:99998;display:inline-flex;align-items:center;gap:8px;
    background:linear-gradient(135deg,#ff2d55,#5b8cff);color:#fff;border:0;border-radius:999px;padding:11px 16px;
    font:600 13px/1 "SF Pro Display","Segoe UI",Inter,system-ui,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.28)}
  #pai-fab:hover{filter:brightness(1.06)}
  #pai-fab svg{width:16px;height:16px}
  #pai-panel{position:fixed;right:18px;bottom:70px;z-index:99999;width:min(440px,calc(100vw - 28px));max-height:min(74vh,640px);
    display:none;flex-direction:column;background:#0e1626;color:#e8edf7;border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;
    box-shadow:0 18px 50px rgba(0,0,0,.45);font-family:"SF Pro Display","Segoe UI",Inter,system-ui,sans-serif}
  #pai-panel.on{display:flex}
  .pai-h{display:flex;align-items:center;gap:8px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,.1)}
  .pai-h b{font-size:14px;font-weight:800}.pai-h .pai-tag{font-size:10px;font-weight:800;background:rgba(91,140,255,.22);color:#bcd2ff;border-radius:6px;padding:2px 6px}
  .pai-x{margin-left:auto;background:none;border:0;color:#8592ad;font-size:20px;cursor:pointer;line-height:1}
  .pai-b{padding:13px 15px;overflow:auto}
  .pai-q{display:flex;gap:8px}
  .pai-q input{flex:1;background:#161f33;border:1px solid rgba(255,255,255,.14);border-radius:10px;color:#e8edf7;font:inherit;font-size:13.5px;padding:10px 12px;outline:none}
  .pai-q input:focus{border-color:#5b8cff}
  .pai-send{background:#5b8cff;border:0;color:#fff;border-radius:10px;padding:0 14px;font:inherit;font-weight:700;cursor:pointer}
  .pai-send:disabled{opacity:.5;cursor:default}
  .pai-hint{color:#8592ad;font-size:11.5px;margin-top:8px;line-height:1.5}
  .pai-hint b{color:#c7d2e6}
  .pai-res{margin-top:12px}
  .pai-int{font-size:12px;color:#bcd2ff;background:rgba(91,140,255,.12);border:1px solid rgba(91,140,255,.25);border-radius:9px;padding:8px 10px;margin-bottom:10px}
  .pai-kpi{display:flex;gap:10px;margin-bottom:10px}
  .pai-kpi .c{flex:1;background:#161f33;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:9px 11px}
  .pai-kpi .l{font-size:10px;color:#8592ad;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
  .pai-kpi .v{font-size:17px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums}
  .pai-dl{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,#22c9a3,#1aa17f);border:0;color:#04140f;border-radius:10px;padding:9px 14px;font:inherit;font-weight:800;font-size:12.5px;cursor:pointer}
  .pai-dl:disabled{opacity:.5;cursor:default}
  .pai-tbl{width:100%;border-collapse:collapse;font-size:11.5px;margin-top:10px}
  .pai-tbl th{text-align:left;color:#8592ad;font-weight:700;padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;background:#0e1626}
  .pai-tbl td{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
  .pai-tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pai-wrap{max-height:230px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:10px;margin-top:8px}
  .pai-err{color:#ff9db0;font-size:12.5px;margin-top:10px}
  .pai-ex{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
  .pai-ex button{background:#161f33;border:1px solid rgba(255,255,255,.12);color:#bcd2ff;border-radius:8px;padding:5px 9px;font:inherit;font-size:11px;cursor:pointer}
  @media (prefers-color-scheme: light){
    #pai-panel{background:#fff;color:#111827;border-color:#e4e7ef}
    .pai-h{border-color:#eef1f7}.pai-q input,.pai-kpi .c,.pai-ex button{background:#f4f6fb;border-color:#e4e7ef;color:#111827}
    .pai-tbl th{background:#fff;color:#5b6472;border-color:#eef1f7}.pai-tbl td{border-color:#f1f3f8}
    .pai-x,.pai-hint{color:#5b6472}.pai-hint b{color:#111827}
  }
  html[data-theme="light"] #pai-panel{background:#fff;color:#111827;border-color:#e4e7ef}
  html[data-theme="light"] .pai-q input,html[data-theme="light"] .pai-kpi .c,html[data-theme="light"] .pai-ex button{background:#f4f6fb;border-color:#e4e7ef;color:#111827}
  html[data-theme="light"] .pai-tbl th{background:#fff;color:#5b6472}
  `;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var fab = document.createElement('button'); fab.id = 'pai-fab';
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg><span>ProLab AI</span>';
  document.body.appendChild(fab);

  var panel = document.createElement('div'); panel.id = 'pai-panel';
  panel.innerHTML =
    '<div class="pai-h"><b>ProLab AI</b><span class="pai-tag">beta</span><button class="pai-x" title="Закрыть">×</button></div>' +
    '<div class="pai-b">' +
      '<div class="pai-q"><input id="pai-input" placeholder="Напр.: приборы Agilent проданные в этом году" autocomplete="off"><button class="pai-send" id="pai-send">Найти</button></div>' +
      '<div class="pai-ex" id="pai-ex"></div>' +
      '<div class="pai-hint">Понимаю: <b>производитель</b>, <b>тип прибора</b> (ААС, ICP-MS, ГХ, ВЭЖХ…) и <b>модель</b> (55, 240, 8890), <b>период</b>, <b>стадии</b> (P10–P80, «выданные КП» = P60+P80), <b>продали</b> (Контракт→Завершена), <b>выигранные</b>, <b>в работе</b>, <b>отдел</b>, <b>менеджер</b>, <b>клиент</b>. Можно сужать несколькими критериями сразу и выгрузить в Excel.</div>' +
      '<div class="pai-res" id="pai-res"></div>' +
    '</div>';
  document.body.appendChild(panel);

  var input = panel.querySelector('#pai-input');
  var res = panel.querySelector('#pai-res');
  var lastQ = '';
  var EX = ['приборы Agilent проданные в этом году', 'выданные КП по хроматографии в этом году', 'сделки Семена Жарова на этапе P10-P80 за 2025', 'выигранные сделки Metrohm за прошлый год'];
  panel.querySelector('#pai-ex').innerHTML = EX.map(function (e) { return '<button>' + e + '</button>'; }).join('');
  panel.querySelectorAll('#pai-ex button').forEach(function (b) { b.onclick = function () { input.value = b.textContent; run(); }; });

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
  function fmtMln(v) { var m = (v || 0) / 1e6; return (Math.abs(m) >= 100 ? fmt(m) : (Math.round(m * 10) / 10).toLocaleString('ru-RU')) + ' млн ₸'; }

  function open() { panel.classList.add('on'); setTimeout(function () { input.focus(); }, 40); }
  function close() { panel.classList.remove('on'); }
  fab.onclick = function () { panel.classList.contains('on') ? close() : open(); };
  panel.querySelector('.pai-x').onclick = close;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  panel.querySelector('#pai-send').onclick = run;

  async function run() {
    var q = input.value.trim(); if (!q) return; lastQ = q;
    var btn = panel.querySelector('#pai-send'); btn.disabled = true; var o = btn.textContent; btn.textContent = '…';
    res.innerHTML = '<div class="pai-hint">Считаю…</div>';
    try {
      var r = await fetch('/api/plsai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q }) });
      if (r.status === 401) { res.innerHTML = '<div class="pai-err">Нужно войти в ЦУП.</div>'; return; }
      var d = await r.json();
      if (!r.ok) { res.innerHTML = '<div class="pai-err">' + esc(d.error || 'Ошибка') + '</div>'; return; }
      var rows = (d.sample || []).map(function (x) {
        return '<tr><td>' + esc(x.company) + '</td><td>' + esc(x.instrument || '—') + '</td><td>' + esc(x.manufacturer || '—') + '</td><td class="num">' + fmt(x.sumKzt) + '</td><td>' + esc(x.manager || '') + '</td></tr>';
      }).join('');
      res.innerHTML =
        '<div class="pai-int">' + esc(d.interpreted) + '</div>' +
        '<div class="pai-kpi"><div class="c"><div class="l">Найдено сделок</div><div class="v">' + fmt(d.count) + '</div></div>' +
        '<div class="c"><div class="l">Сумма</div><div class="v">' + fmtMln(d.sumKzt) + '</div></div></div>' +
        (d.count ? '<button class="pai-dl" id="pai-dl">⬇ Скачать Excel (' + fmt(d.count) + ')</button>' : '<div class="pai-hint">Ничего не нашлось по этому запросу. Попробуй переформулировать (бренд, период, отдел).</div>') +
        (rows ? '<div class="pai-wrap"><table class="pai-tbl"><thead><tr><th>Компания</th><th>Прибор</th><th>Произв.</th><th class="num">Сумма ₸</th><th>Менеджер</th></tr></thead><tbody>' + rows + '</tbody></table></div>' + (d.count > d.sample.length ? '<div class="pai-hint" style="margin-top:6px">Показаны первые ' + d.sample.length + '. В Excel — все ' + fmt(d.count) + '.</div>' : '') : '');
      var dl = panel.querySelector('#pai-dl'); if (dl) dl.onclick = doExport;
    } catch (e) { res.innerHTML = '<div class="pai-err">Ошибка сети</div>'; }
    finally { btn.disabled = false; btn.textContent = o; }
  }

  async function doExport() {
    var dl = panel.querySelector('#pai-dl'); if (!dl) return; dl.disabled = true; var o = dl.textContent; dl.textContent = 'Готовлю…';
    try {
      var r = await fetch('/api/plsai/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: lastQ }) });
      if (!r.ok) { var e = await r.json().catch(function () { return {}; }); throw new Error(e.error || 'Ошибка'); }
      var blob = await r.blob(); var u = URL.createObjectURL(blob); var a = document.createElement('a');
      a.href = u; a.download = 'ProLabAI_' + lastQ.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 40) + '.xlsx'; a.click(); URL.revokeObjectURL(u);
      dl.textContent = '✓ Скачано'; setTimeout(function () { dl.textContent = o; dl.disabled = false; }, 1500);
    } catch (e) { alert('Не удалось выгрузить: ' + e.message); dl.textContent = o; dl.disabled = false; }
  }
})();

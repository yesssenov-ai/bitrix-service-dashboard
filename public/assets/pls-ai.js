/* ProLab AI — плавающий ассистент ЦУП (кнопка снизу справа, перетаскивается).
   Подключается одним тегом <script src="/assets/pls-ai.js" defer></script>.
   Диалог: вопрос → ответ, история хранится на сервере отдельно по каждому сотруднику
   (/api/plsai/history). Понимает выборки сделок, «Реализацию» (даты отгрузки/поставки)
   и вопросы о самом ЦУП. Выгрузка в Excel. */
(function () {
  if (window.__prolabAI) return; window.__prolabAI = true;
  var css = `
  #pai-fab{position:fixed;right:18px;bottom:72px;z-index:99998;display:inline-flex;align-items:center;gap:8px;
    background:linear-gradient(135deg,#ff2d55,#5b8cff);color:#fff;border:0;border-radius:999px;padding:11px 16px;
    font:600 13px/1 "SF Pro Display","Segoe UI",Inter,system-ui,sans-serif;cursor:grab;box-shadow:0 8px 24px rgba(0,0,0,.28);
    touch-action:none;user-select:none;-webkit-user-select:none}
  #pai-fab.dragging{cursor:grabbing}
  #pai-fab:hover{filter:brightness(1.06)}
  #pai-fab svg{width:16px;height:16px}
  #pai-panel{position:fixed;right:18px;bottom:70px;z-index:99999;width:min(460px,calc(100vw - 24px));height:min(76vh,660px);max-height:calc(100vh - 36px);
    display:none;flex-direction:column;background:#0e1626;color:#e8edf7;border:1px solid rgba(255,255,255,.12);border-radius:18px;overflow:hidden;
    box-shadow:0 24px 60px rgba(0,0,0,.5);font-family:"SF Pro Display","Segoe UI",Inter,system-ui,sans-serif}
  #pai-panel.on{display:flex}
  .pai-h{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}
  .pai-h b{font-size:14.5px;font-weight:800;letter-spacing:.2px}.pai-h .pai-tag{font-size:10px;font-weight:800;background:rgba(91,140,255,.22);color:#bcd2ff;border-radius:6px;padding:2px 7px}
  .pai-clear{margin-left:auto;width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:none;border:0;border-radius:8px;color:#8592ad;font-size:14px;cursor:pointer}
  .pai-clear:hover{color:#ff9db0;background:rgba(255,255,255,.06)}
  .pai-x{width:28px;height:28px;display:flex;align-items:center;justify-content:center;background:none;border:0;border-radius:8px;color:#8592ad;font-size:19px;cursor:pointer}
  .pai-x:hover{color:#e8edf7;background:rgba(255,255,255,.06)}
  .pai-b{flex:1;display:flex;flex-direction:column;min-height:0;padding:0;overflow:hidden}
  .pai-thread{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
  .pai-msg{max-width:100%;border-radius:14px;padding:10px 13px;font-size:13px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere}
  .pai-msg.user{align-self:flex-end;max-width:86%;background:linear-gradient(135deg,#ff2d55,#5b8cff);color:#fff;border-bottom-right-radius:5px;font-weight:600;box-shadow:0 3px 12px rgba(91,140,255,.25)}
  .pai-msg.bot{align-self:stretch;background:#141d2e;border:1px solid rgba(255,255,255,.07);border-bottom-left-radius:5px}
  .pai-empty{margin:auto;text-align:center;color:#8592ad;font-size:12.5px;line-height:1.6;padding:14px}
  .pai-empty .pai-em-t{font-size:15px;font-weight:800;color:#c7d2e6;margin-bottom:6px}
  .pai-composer{border-top:1px solid rgba(255,255,255,.08);padding:12px 14px;flex-shrink:0}
  .pai-ex{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
  .pai-ex button{background:#161f33;border:1px solid rgba(255,255,255,.12);color:#bcd2ff;border-radius:8px;padding:5px 9px;font:inherit;font-size:11px;cursor:pointer;text-align:left}
  .pai-ex button:hover{border-color:#5b8cff}
  .pai-q{display:flex;gap:8px}
  .pai-q input{flex:1;min-width:0;background:#161f33;border:1px solid rgba(255,255,255,.14);border-radius:11px;color:#e8edf7;font:inherit;font-size:13.5px;padding:11px 13px;outline:none;transition:border-color .12s}
  .pai-q input:focus{border-color:#5b8cff}
  .pai-send{background:#5b8cff;border:0;color:#fff;border-radius:11px;padding:0 18px;font:inherit;font-weight:700;cursor:pointer}
  .pai-send:hover{filter:brightness(1.06)}
  .pai-send:disabled{opacity:.5;cursor:default}
  .pai-hint{color:#8592ad;font-size:11.5px;line-height:1.5}
  .pai-hint b{color:#c7d2e6}
  .pai-int{font-size:12px;color:#bcd2ff;background:rgba(91,140,255,.12);border:1px solid rgba(91,140,255,.25);border-radius:9px;padding:7px 9px;margin-bottom:9px}
  .pai-answer{font-size:13px;line-height:1.55;color:#e8edf7;white-space:normal}
  .pai-kpi{display:flex;gap:10px;margin-bottom:10px}
  .pai-kpi .c{flex:1;background:#0e1626;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:8px 10px}
  .pai-kpi .l{font-size:10px;color:#8592ad;text-transform:uppercase;letter-spacing:.4px;font-weight:700}
  .pai-kpi .v{font-size:16px;font-weight:800;margin-top:3px;font-variant-numeric:tabular-nums}
  .pai-opts{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}
  .pai-opt{background:#5b8cff;border:0;color:#fff;border-radius:9px;padding:8px 13px;font:inherit;font-weight:700;font-size:12.5px;cursor:pointer}
  .pai-opt:hover{filter:brightness(1.08)}
  .pai-dl{display:inline-flex;align-items:center;gap:7px;background:linear-gradient(135deg,#22c9a3,#1aa17f);border:0;color:#04140f;border-radius:10px;padding:8px 13px;font:inherit;font-weight:800;font-size:12px;cursor:pointer}
  .pai-dl:disabled{opacity:.5;cursor:default}
  .pai-tbl{width:100%;border-collapse:collapse;font-size:11px;margin-top:9px}
  .pai-tbl th{text-align:left;color:#8592ad;font-weight:700;padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;background:#161f33}
  .pai-tbl td{padding:5px 6px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
  .pai-tbl .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pai-wrap{max-height:210px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:10px;margin-top:8px}
  .pai-fc{margin-top:4px;border:1px solid rgba(255,255,255,.08);border-radius:11px;overflow:hidden}
  .pai-fc-r{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid rgba(255,255,255,.06);font-size:12.5px}
  .pai-fc-r span{flex:1}.pai-fc-r b{font-weight:800;color:#22c9a3;font-variant-numeric:tabular-nums}.pai-fc-r i{color:#8592ad;font-style:normal;font-size:11px;min-width:52px;text-align:right}
  .pai-fc-sub{padding:6px 11px 6px 24px;font-size:11.5px;color:#8592ad;border-bottom:1px solid rgba(255,255,255,.04)}
  .pai-fc-sub:last-child{border-bottom:0}
  .pai-pace{margin:2px 0 10px;padding:8px 11px;border:1px solid;border-radius:10px;display:flex;flex-direction:column;gap:2px}
  .pai-pace b{font-size:12.5px;font-weight:800}.pai-pace span{font-size:11px;color:#8592ad}
  .pai-fc-h{margin-top:10px;font-size:12px;font-weight:700;color:#c7d2e6}
  .pai-sign{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:12.5px;flex-wrap:wrap}
  .pai-sign span{flex:1;min-width:120px}.pai-sign b{color:#22c9a3;font-weight:800;font-variant-numeric:tabular-nums}
  .pai-sn{flex-basis:100%;color:#8592ad;font-size:11px;font-style:italic;margin-top:2px}
  html[data-theme="light"] .pai-fc-h{color:#111827}
  .pai-err{color:#ff9db0;font-size:12.5px}
  .pai-time{font-size:10px;color:#6b7690;margin-top:7px}
  @media (prefers-color-scheme: light){
    #pai-panel{background:#fff;color:#111827;border-color:#e4e7ef}
    .pai-h{border-color:#eef1f7}.pai-q input,.pai-ex button,.pai-kpi .c{background:#f4f6fb;border-color:#e4e7ef;color:#111827}
    .pai-msg.bot{background:#f4f6fb;border-color:#e6e9f1}
    .pai-tbl th{background:#f4f6fb;color:#5b6472;border-color:#eef1f7}.pai-tbl td{border-color:#f1f3f8}
    .pai-x,.pai-hint,.pai-empty{color:#5b6472}.pai-hint b,.pai-empty .pai-em-t{color:#111827}
    .pai-answer{color:#111827}.pai-composer{border-color:#eef1f7}
  }
  html[data-theme="light"] #pai-panel{background:#fff;color:#111827;border-color:#e4e7ef}
  html[data-theme="light"] .pai-q input,html[data-theme="light"] .pai-ex button,html[data-theme="light"] .pai-kpi .c{background:#f4f6fb;border-color:#e4e7ef;color:#111827}
  html[data-theme="light"] .pai-msg.bot{background:#f4f6fb;border-color:#e6e9f1}
  html[data-theme="light"] .pai-tbl th{background:#f4f6fb;color:#5b6472}
  html[data-theme="light"] .pai-answer{color:#111827}
  html[data-theme="light"] .pai-composer{border-color:#eef1f7}
  html[data-theme="light"] .pai-fc,html[data-theme="light"] .pai-fc-r,html[data-theme="light"] .pai-fc-sub{border-color:#e6e9f1}
  @media (prefers-color-scheme: light){ .pai-fc,.pai-fc-r,.pai-fc-sub{border-color:#e6e9f1} }
  `;
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var fab = document.createElement('button'); fab.id = 'pai-fab';
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg><span>ProLab AI</span>';
  document.body.appendChild(fab);

  var panel = document.createElement('div'); panel.id = 'pai-panel';
  panel.innerHTML =
    '<div class="pai-h"><b>ProLab AI</b><span class="pai-tag">2.0</span>' +
      '<button class="pai-clear" id="pai-clear" title="Очистить историю">🗑</button>' +
      '<button class="pai-x" title="Закрыть">×</button></div>' +
    '<div class="pai-b">' +
      '<div class="pai-thread" id="pai-thread"></div>' +
      '<div class="pai-composer">' +
        '<div class="pai-q"><input id="pai-input" placeholder="Спросите что угодно по ЦУП…" autocomplete="off"><button class="pai-send" id="pai-send">Найти</button></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(panel);

  var input = panel.querySelector('#pai-input');
  var thread = panel.querySelector('#pai-thread');
  var send = panel.querySelector('#pai-send');

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmt(n) { return Math.round(n || 0).toLocaleString('ru-RU').replace(/,/g, ' '); }
  function fmtMln(v) { var m = (v || 0) / 1e6; return (Math.abs(m) >= 100 ? fmt(m) : (Math.round(m * 10) / 10).toLocaleString('ru-RU')) + ' млн ₸'; }

  // ── Лента сообщений ─────────────────────────────────────────────────────────
  function scrollBottom() { thread.scrollTop = thread.scrollHeight; }
  var MYNAME = '';
  function firstName(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
  function greetWord() { var h = new Date().getHours(); return h < 6 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер'; }
  function greetLine() { return greetWord() + (MYNAME ? ', ' + MYNAME : '') + '!'; }
  var meLoaded = false;
  function loadMe() {
    if (meLoaded) return; meLoaded = true;
    fetch('/api/plsai/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.name) { MYNAME = firstName(d.name); var t = thread.querySelector('.pai-em-t'); if (t) t.textContent = greetLine(); }
    }).catch(function () {});
  }
  function updateEmpty() {
    var msgs = thread.querySelectorAll('.pai-msg').length;
    var empt = thread.querySelector('.pai-empty');
    if (!msgs && !empt) {
      var d = document.createElement('div'); d.className = 'pai-empty';
      d.innerHTML = '<div class="pai-em-t">' + greetLine() + '</div><div>Спросите что угодно по ЦУП — сделки, рейтинги, прогноз, статус модулей.</div>';
      thread.appendChild(d);
    } else if (msgs && empt) { empt.remove(); }
  }
  function addUser(text) { var d = document.createElement('div'); d.className = 'pai-msg user'; d.textContent = text; updateEmpty(); thread.appendChild(d); scrollBottom(); return d; }
  function addBot(html) { var d = document.createElement('div'); d.className = 'pai-msg bot'; d.innerHTML = html; updateEmpty(); thread.appendChild(d); scrollBottom(); return d; }

  // Единая отрисовка ответа (и для живого запроса, и для истории). q — сам вопрос.
  function botHTML(d, q) {
    if (d.error) return '<div class="pai-err">' + esc(d.error) + '</div>';
    if (d.answer) return '<div class="pai-int">🧠 Ассистент ЦУП</div><div class="pai-answer">' + esc(d.answer).replace(/\n/g, '<br>') + '</div>';
    if (d.clarify) {
      var ch = '<div class="pai-int">🧠 Уточните, пожалуйста</div><div class="pai-hint">' + esc(d.clarify) + '</div>';
      if (d.options && d.options.length) ch += '<div class="pai-opts">' + d.options.map(function (o) { return '<button class="pai-opt" data-q="' + esc(o.q) + '">' + esc(o.label) + '</button>'; }).join('') + '</div>';
      return ch;
    }
    // Win-rate / конверсия по менеджерам или отделам.
    if (d.winrate) {
      var wt = d.totals || {};
      var wh = '<div class="pai-int">🎯 Win-rate по ' + (d.group === 'department' ? 'отделам' : 'менеджерам') + ' · ' + esc(d.period && d.period.label) + (d.deptLabel ? ' · ' + esc(d.deptLabel) : '') + '</div>';
      wh += '<div class="pai-wrap"><table class="pai-tbl"><thead><tr><th>' + (d.group === 'department' ? 'Отдел' : 'Менеджер') + '</th><th class="num">Win-rate</th><th class="num">Пайплайн</th><th class="num">Реально ×WR</th></tr></thead><tbody>';
      wh += (d.rows || []).map(function (x) {
        var wr = x.winRate == null ? '—' : x.winRate + '%';
        var wrCol = x.winRate == null ? '#8592ad' : (x.winRate >= 60 ? '#22c9a3' : x.winRate >= 35 ? '#e6a01e' : '#ff6b81');
        return '<tr><td>' + esc(x.label) + '</td><td class="num" style="font-weight:800;color:' + wrCol + '">' + wr + '</td><td class="num" style="color:#8592ad">' + fmtMln(x.openSum) + '</td><td class="num" style="color:#22c9a3">' + fmtMln(x.honest || 0) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
      wh += '<div class="pai-hint" style="margin-top:7px">«Пайплайн» — открытые сделки сейчас. «Реально ×WR» — пайплайн, взвешенный на личную конверсию (честная оценка). Итого честно: ' + fmtMln(wt.honest) + ' из ' + fmtMln(wt.open) + ' пайплайна.</div>';
      wh += '<div class="pai-hint" style="margin-top:6px">Win-rate = выигранные ÷ (выигранные + проигранные) по сумме. По деньгам за период.</div>';
      return wh;
    }
    // Sales Velocity.
    if (d.velocity) {
      var vh = '<div class="pai-int">⚡ Sales Velocity · ' + esc(d.scopeLabel) + ' · ' + esc(d.period && d.period.label) + '</div>';
      vh += '<div class="pai-kpi"><div class="c"><div class="l">Скорость</div><div class="v" style="font-size:14px">' + fmtMln(d.perDay) + '/день</div></div>' +
        '<div class="c"><div class="l">≈ в месяц</div><div class="v" style="font-size:14px">' + fmtMln(d.perMonth) + '</div></div></div>';
      vh += '<div class="pai-fc">';
      vh += '<div class="pai-fc-r"><span>Открытых сделок</span><b>' + fmt(d.openCount) + '</b><i>' + fmtMln(d.openSum) + '</i></div>';
      vh += '<div class="pai-fc-r"><span>Win-rate</span><b>' + d.winRate + '%</b><i>' + d.wonCount + '/' + (d.wonCount + d.lostCount) + '</i></div>';
      vh += '<div class="pai-fc-r"><span>Средний чек</span><b>' + fmtMln(d.avgDeal) + '</b><i></i></div>';
      vh += '<div class="pai-fc-r"><span>Длина цикла</span><b>' + d.cycleDays + ' дн.</b><i></i></div>';
      vh += '</div>';
      vh += '<div class="pai-hint" style="margin-top:7px">Формула: (сделок × win-rate × чек) ÷ цикл. Рычаги — что сильнее двигает выручку: количество, конверсия, чек или скорость цикла.</div>';
      return vh;
    }
    // Прогноз продаж на месяц (честный, от факта и темпа).
    if (d.forecast) {
      var e = d.estimate || {}, rf = d.refs || {}, cm = d.comments || {}, dy = d.days || {};
      var fh = '<div class="pai-int">🔮 Прогноз продаж · ' + esc(d.period && d.period.label) + (dy.remaining != null ? ' · осталось ' + dy.remaining + ' раб. дн.' : '') + '</div>';
      fh += '<div class="pai-kpi"><div class="c"><div class="l">Реалистичный итог</div><div class="v">' + fmtMln(e.point) + '</div></div>' +
        '<div class="c"><div class="l">Диапазон</div><div class="v" style="font-size:12.5px">' + fmtMln(e.low) + ' – ' + fmtMln(e.high) + '</div></div></div>';
      if (d.pacing) {
        var pv = d.pacing, col = pv.verdict === 'ahead' ? '#22c9a3' : pv.verdict === 'behind' ? '#ff6b81' : '#e6a01e';
        var pw = pv.verdict === 'ahead' ? '🟢 идём с опережением' : pv.verdict === 'behind' ? '🔴 отстаём от графика' : '🟡 идём в графике';
        fh += '<div class="pai-pace" style="border-color:' + col + '44;background:' + col + '14"><b style="color:' + col + '">' + pw + ' ' + (pv.pct > 0 ? '+' : '') + pv.pct + '%</b><span>обычно к этому дню ~' + fmtMln(pv.expectedByNow) + ', у нас ' + fmtMln(d.actual.sum) + '</span></div>';
      }
      fh += '<div class="pai-fc">';
      fh += '<div class="pai-fc-r"><span>✅ Уже подписано</span><b>' + fmtMln(d.actual.sum) + '</b><i>' + d.actual.count + ' сд.</i></div>';
      fh += '<div class="pai-fc-r"><span>➕ Реально до конца месяца</span><b>+' + fmtMln(d.expectedRemaining) + '</b><i></i></div>';
      if (d.basis) fh += '<div class="pai-fc-sub">' + esc(d.basis) + '</div>';
      fh += '</div>';
      // На подписании (по комментариям).
      if (cm.signing && cm.signing.length) {
        fh += '<div class="pai-fc-h">🖊 На подписании (из комментариев):</div>';
        fh += cm.signing.map(function (s) {
          return '<div class="pai-sign"><span>' + esc(s.company || '—') + '</span><b>' + fmtMln(s.sum) + '</b>' + (s.snippet ? '<div class="pai-sn">«' + esc(s.snippet) + '»</div>' : '') + '</div>';
        }).join('');
      }
      fh += '<div class="pai-hint" style="margin-top:8px">📦 Воронка на месяц целиком: ' + fmtMln(d.weighted) + ' (взвеш.). Потолок, если бы всё закрылось: ' + fmtMln(d.ceiling) + '. Вероятно уедет на след. месяц: <b>' + fmtMln(d.slip) + '</b>.</div>';
      if (cm.stalled) fh += '<div class="pai-hint" style="margin-top:6px">⚠ Застряли по комментариям (согласование/ожидание): ' + cm.stalled + ' сд.</div>';
      // Риск проскальзывания (висят дольше типичного цикла).
      if (d.slipRisk && d.slipRisk.count) {
        fh += '<div class="pai-fc-h">🐌 Риск переноса (висят > ' + Math.round((d.typCycle || 60) * 1.3) + ' дн., дольше цикла): ' + d.slipRisk.count + ' сд. на ' + fmtMln(d.slipRisk.sum) + '</div>';
        fh += (d.slipRisk.items || []).map(function (s) { return '<div class="pai-sign"><span>' + esc(s.company || '—') + '</span><b style="color:#ff9db0">' + fmtMln(s.sum) + '</b><div class="pai-sn">возраст ' + s.age + ' дн.</div></div>'; }).join('');
      }
      // Разрез по отделам.
      if (d.deptBreak && d.deptBreak.length) {
        fh += '<div class="pai-fc-h">🏢 По отделам (подписано / воронка взвеш.):</div>';
        fh += '<div class="pai-wrap"><table class="pai-tbl"><thead><tr><th>Отдел</th><th class="num">Подписано</th><th class="num">Воронка</th></tr></thead><tbody>' +
          d.deptBreak.map(function (x) { return '<tr><td>' + esc(x.dept) + '</td><td class="num" style="color:#22c9a3">' + fmtMln(x.signed) + '</td><td class="num" style="color:#8592ad">' + fmtMln(x.pipeline) + '</td></tr>'; }).join('') +
          '</tbody></table></div>';
      }
      var refLine = 'Ориентиры: темп с начала года ~' + fmtMln(rf.runRate) + '/мес · этот месяц год назад ' + fmtMln(rf.lastYear && rf.lastYear.sum);
      if (rf.onTimeRate != null) refLine += ' · планов в срок ' + rf.onTimeRate + '%';
      fh += '<div class="pai-hint" style="margin-top:8px">' + refLine + '.</div>';
      fh += '<div class="pai-hint" style="margin-top:6px">Прогноз ведётся от факта и темпа по дням' + (rf.paceMonths ? ' (' + rf.paceMonths + ' мес. истории)' : '') + ', воронка ужата на оставшееся время. Не гарантия.</div>';
      return fh;
    }
    // Рейтинг/агрегация (кто больше всех, топ, разбивка). Показываем выбранную метрику + сделки.
    if (d.aggregate) {
      var mt = d.metric || 'count';
      var mLbl = mt === 'sum' ? 'Сумма ₸' : mt === 'avg' ? 'Ср./сделку' : mt === 'max' ? 'Крупнейшая' : 'Кол-во';
      var mVal = function (x) { return mt === 'sum' ? fmtMln(x.sumKzt) : mt === 'avg' ? fmtMln(x.avgKzt) : mt === 'max' ? fmtMln(x.maxKzt) : fmt(x.count); };
      var secLbl = mt === 'count' ? 'Сумма' : 'Сделок';
      var secVal = function (x) { return mt === 'count' ? fmtMln(x.sumKzt) : fmt(x.count); };
      var rr = (d.rows || []).map(function (x, i) {
        return '<tr><td class="num">' + (i + 1) + '</td><td>' + esc(x.label) + '</td>' +
          '<td class="num" style="font-weight:800;color:#22c9a3">' + mVal(x) + '</td>' +
          '<td class="num" style="color:#8592ad">' + secVal(x) + '</td></tr>';
      }).join('');
      var ah = '<div class="pai-int">🏆 ' + esc(d.interpreted || '') + '</div>' +
        '<div class="pai-wrap"><table class="pai-tbl"><thead><tr><th class="num">#</th><th>Название</th><th class="num">' + mLbl + '</th><th class="num">' + secLbl + '</th></tr></thead><tbody>' + rr + '</tbody></table></div>';
      if (d.total) ah += '<div class="pai-hint" style="margin-top:7px">Всего сделок: ' + fmt(d.total.count) + ' · сумма ' + fmtMln(d.total.sumKzt) + '</div>';
      ah += '<button class="pai-dl" data-q="' + esc(q) + '" style="margin-top:8px">⬇ Excel</button>';
      return ah;
    }
    var head = (d.ai ? '🧠 ' : (d.ops ? '📦 ' : '')) + esc(d.interpreted || '') + (d.ai && !d.ops ? ' · понято ИИ' : '');
    var h = '<div class="pai-int">' + head + '</div>';
    if (d.note) h += '<div class="pai-hint" style="margin:-2px 0 8px">💡 ' + esc(d.note) + '</div>';
    h += '<div class="pai-kpi"><div class="c"><div class="l">Сделок</div><div class="v">' + fmt(d.count || 0) + '</div></div>' +
         '<div class="c"><div class="l">Сумма</div><div class="v">' + fmtMln(d.sumKzt || 0) + '</div></div></div>';
    if (d.count) h += '<button class="pai-dl" data-q="' + esc(q) + '">⬇ Excel (' + fmt(d.count) + ')</button>';
    else h += '<div class="pai-hint">Ничего не нашлось по этому запросу.</div>';
    if (d.sample && d.sample.length) {
      var thead, rows;
      if (d.ops) {
        thead = '<th>Компания</th><th>Стадия</th><th>' + esc(d.dateLabel || 'Отгрузка') + '</th><th>Менеджер</th>';
        rows = d.sample.map(function (x) {
          return '<tr><td>' + esc(x.company) + '</td><td>' + esc(x.stage || '—') + '</td><td class="num" style="color:#22c9a3;font-weight:700">' + esc(x.factoryShipDate || '—') + '</td><td>' + esc(x.manager || '') + '</td></tr>';
        }).join('');
      } else {
        thead = '<th>Компания</th><th>Прибор</th><th>Произв.</th><th class="num">Сумма ₸</th><th>Менеджер</th>';
        rows = d.sample.map(function (x) {
          return '<tr><td>' + esc(x.company) + '</td><td>' + esc(x.instrument || '—') + '</td><td>' + esc(x.manufacturer || '—') + '</td><td class="num">' + fmt(x.sumKzt) + '</td><td>' + esc(x.manager || '') + '</td></tr>';
        }).join('');
      }
      h += '<div class="pai-wrap"><table class="pai-tbl"><thead><tr>' + thead + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      if (d.count > d.sample.length) h += '<div class="pai-hint" style="margin-top:6px">Показаны первые ' + d.sample.length + '. В Excel — все ' + fmt(d.count) + '.</div>';
    }
    return h;
  }

  // ── Позиционирование панели рядом с кнопкой (куда бы её ни перетащили) ──────
  function positionPanel() {
    var r = fab.getBoundingClientRect();
    var pw = panel.offsetWidth || Math.min(440, window.innerWidth - 28);
    var ph = panel.offsetHeight || 480;
    var left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8));
    var top;
    if (r.top - ph - 10 >= 8) top = r.top - ph - 10;
    else if (r.bottom + ph + 10 <= window.innerHeight - 8) top = r.bottom + 10;
    else top = Math.max(8, window.innerHeight - ph - 8);
    panel.style.left = left + 'px'; panel.style.top = top + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  }

  var historyLoaded = false;
  async function loadHistory() {
    if (historyLoaded) return; historyLoaded = true;
    try {
      var r = await fetch('/api/plsai/history'); if (!r.ok) return;
      var d = await r.json();
      (d.items || []).forEach(function (t) { addUser(t.q); addBot(botHTML(t, t.q)); });
      updateEmpty(); scrollBottom();
    } catch (e) { /* без истории — не критично */ }
  }

  function open() { panel.classList.add('on'); positionPanel(); updateEmpty(); loadMe(); loadHistory(); setTimeout(function () { try { input.focus(); } catch (e) {} scrollBottom(); }, 50); }
  function close() { panel.classList.remove('on'); }
  panel.querySelector('.pai-x').onclick = close;
  panel.querySelector('#pai-clear').onclick = async function () {
    if (!confirm('Очистить всю историю ваших запросов к ProLab AI?')) return;
    try { await fetch('/api/plsai/history/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
    thread.innerHTML = ''; updateEmpty();
  };

  // ── Перетаскивание кнопки в любое место экрана (мышь + тач) ─────────────────
  var POSKEY = 'pls-ai-pos';
  function applyFabPos(left, top) {
    var r = fab.getBoundingClientRect(); var w = r.width || 120, h = r.height || 44;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    top = Math.max(6, Math.min(top, window.innerHeight - h - 6));
    fab.style.left = left + 'px'; fab.style.top = top + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto';
  }
  try { var sp = JSON.parse(localStorage.getItem(POSKEY) || 'null'); if (sp && typeof sp.left === 'number') applyFabPos(sp.left, sp.top); } catch (e) {}

  var dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  fab.addEventListener('pointerdown', function (e) {
    dragging = true; moved = false;
    var r = fab.getBoundingClientRect(); ox = e.clientX - r.left; oy = e.clientY - r.top; sx = e.clientX; sy = e.clientY;
    fab.classList.add('dragging'); try { fab.setPointerCapture(e.pointerId); } catch (_) {}
  });
  fab.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    if (Math.abs(e.clientX - sx) > 4 || Math.abs(e.clientY - sy) > 4) moved = true;
    if (moved) { applyFabPos(e.clientX - ox, e.clientY - oy); if (panel.classList.contains('on')) positionPanel(); }
  });
  function endDrag(e) {
    if (!dragging) return; dragging = false; fab.classList.remove('dragging');
    try { fab.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved) { var r = fab.getBoundingClientRect(); try { localStorage.setItem(POSKEY, JSON.stringify({ left: r.left, top: r.top })); } catch (_) {} }
    else { panel.classList.contains('on') ? close() : open(); }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', function () { var r = fab.getBoundingClientRect(); applyFabPos(r.left, r.top); if (panel.classList.contains('on')) positionPanel(); });

  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  send.onclick = run;
  // Клики внутри ленты: скачать Excel / выбрать вариант уточнения.
  thread.addEventListener('click', function (e) {
    var dl = e.target.closest('.pai-dl'); if (dl) { doExport(dl.getAttribute('data-q'), dl); return; }
    var op = e.target.closest('.pai-opt'); if (op) { input.value = op.getAttribute('data-q'); run(); }
  });

  async function run() {
    var q = input.value.trim(); if (!q) return;
    input.value = '';
    addUser(q);
    var bot = addBot('<div class="pai-hint">Думаю…</div>');
    send.disabled = true;
    try {
      var r = await fetch('/api/plsai/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q }) });
      if (r.status === 401) { bot.innerHTML = '<div class="pai-err">Нужно войти в ЦУП.</div>'; return; }
      var d = await r.json();
      if (!r.ok) { bot.innerHTML = '<div class="pai-err">' + esc(d.error || 'Ошибка') + '</div>'; return; }
      bot.innerHTML = botHTML(d, q); scrollBottom();
    } catch (e) { bot.innerHTML = '<div class="pai-err">Ошибка сети</div>'; }
    finally { send.disabled = false; }
  }

  async function doExport(q, btn) {
    if (!q) return; var o = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = 'Готовлю…'; }
    try {
      var r = await fetch('/api/plsai/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: q }) });
      if (!r.ok) { var e = await r.json().catch(function () { return {}; }); throw new Error(e.error || 'Ошибка'); }
      var blob = await r.blob(); var u = URL.createObjectURL(blob); var a = document.createElement('a');
      a.href = u; a.download = 'ProLabAI_' + q.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 40) + '.xlsx'; a.click(); URL.revokeObjectURL(u);
      if (btn) { btn.textContent = '✓ Скачано'; setTimeout(function () { btn.textContent = o; btn.disabled = false; }, 1500); }
    } catch (e) { alert('Не удалось выгрузить: ' + e.message); if (btn) { btn.textContent = o; btn.disabled = false; } }
  }
})();

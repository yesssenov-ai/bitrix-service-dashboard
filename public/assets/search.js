/* Глобальный поиск ЦУП + командная палитра (Ctrl/Cmd+K).
   Одно поле: модули (быстрый переход), компании и сделки (из /api/search → карточка Bitrix).
   Самодостаточно, без зависимостей; тема из cup-ui переменных (с фолбэками). */
(function () {
  'use strict';
  if (window.__plsSearch) return; window.__plsSearch = true;

  // Список модулей для палитры (code, name, href) — синхронно с порталом.
  var MODULES = [
    { c: 'PLN', n: 'Планировщик', h: '/planner.html' },
    { c: 'SVC', n: 'Сервисные заявки', h: '/index.html' },
    { c: 'EQP', n: 'Карта оборудования', h: '/equipment-map.html' },
    { c: 'LIC', n: 'Карта лицензий ГМК', h: '/licenses-map.html' },
    { c: 'REL', n: 'Связи сделок', h: '/relations.html' },
    { c: 'MAIL', n: 'Почта', h: '/mail.html' },
    { c: 'KP', n: 'Коммерческие предложения', h: '/kp-hub.html' },
    { c: 'BONUS', n: 'Бонусы инженеров', h: '/bonus.html' },
    { c: 'STATS', n: 'Статистика', h: '/stats.html' },
    { c: 'CONTR', n: 'Контракты', h: '/contracts.html' },
    { c: 'DEBT', n: 'Дебет', h: '/finance-debt.html' },
    { c: 'STOCK', n: 'Склад', h: '/finance-stock.html' },
    { c: 'QUALITY', n: 'Качество', h: '/finance-quality.html' },
    { c: 'ADV', n: 'Авансы', h: '/finance-advances.html' },
    { c: 'CASHFLOW', n: 'Cash Flow', h: '/finance-cashflow.html' },
    { c: 'CMP', n: 'Компании', h: '/companies.html' },
    { c: 'SALE', n: 'План продаж', h: '/plansales.html' },
    { c: 'NKT', n: 'НКТ', h: '/nct.html' },
    { c: 'PROJ', n: 'Проекты КАМ', h: '/projects.html' },
    { c: 'LOG', n: 'Логистика', h: '/logistics.html' },
    { c: 'OPS', n: 'Реализация', h: '/operational.html' },
    { c: 'PROC', n: 'Закупки', h: '/procurement.html' },
    { c: 'CAM', n: 'Рассылки', h: '/campaigns.html' },
    { c: 'ADM', n: 'Управление', h: '/admin.html' }
  ];
  var ACCOUNT = { c: 'КАБ', n: 'Мой кабинет', h: '/account.html' };

  function cssVar(n, d) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return v && v.trim() ? v.trim() : d; } catch (e) { return d; } }
  function el(tag, css, html) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }); }
  function mln(v) { return (Math.round(((v || 0) / 1e6) * 10) / 10).toLocaleString('ru-RU') + ' млн ₸'; }

  var allowed = null; // '*' (админ) | Set(codes) | null (ещё не грузили)
  function loadAccess() {
    return fetch('/api/portal/my-access', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) { allowed = (a && a.admin) ? '*' : new Set((a && a.modules) || []); })
      .catch(function () { allowed = new Set(); });
  }
  function allowedModules() {
    var list = MODULES.filter(function (m) { return allowed === '*' || (allowed && allowed.has(m.c)); });
    return list.concat([ACCOUNT]);
  }

  // ── Запуск: плавающая кнопка поиска (над кнопкой фидбэка) + Ctrl/Cmd+K ──
  function mountButton() {
    if (document.getElementById('pls-sr-btn')) return;
    if (!document.getElementById('pls-sr-style')) {
      var st = document.createElement('style'); st.id = 'pls-sr-style';
      st.textContent = '#pls-sr-btn{position:fixed;right:16px;bottom:56px;z-index:2147483600;width:34px;height:34px;' +
        'border-radius:9px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;' +
        'background:var(--surface,#fff);color:var(--text-2,#3a4254);border:1px solid var(--line-2,#d6dbe4);' +
        'box-shadow:0 1px 2px rgba(20,25,35,.06);transition:color .15s,border-color .15s}' +
        '#pls-sr-btn:hover{color:var(--text,#101624);border-color:var(--text-3,#6a7488)}#pls-sr-btn svg{width:18px;height:18px;display:block}';
      document.head.appendChild(st);
    }
    var b = el('button', null,
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>');
    b.id = 'pls-sr-btn';
    b.title = 'Поиск по ЦУП (Ctrl+K)';
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', openOverlay);
    document.body.appendChild(b);
  }

  var ov = null, input = null, listBox = null, items = [], sel = 0, token = 0, debTimer = null;

  function openOverlay() {
    if (ov) { input.focus(); input.select(); return; }
    if (allowed === null) loadAccess();
    var sur = cssVar('--surface', '#fff'), text = cssVar('--text', '#101624'), line = cssVar('--line', '#e7eaf0'),
        sub = cssVar('--text-3', '#6a7488'), sur2 = cssVar('--surface-2', '#f1f3f6'), accent = cssVar('--accent', '#C53B2F');
    ov = el('div', ['position:fixed', 'inset:0', 'z-index:2147483602', 'background:rgba(0,0,0,.4)',
      'display:flex', 'align-items:flex-start', 'justify-content:center', 'padding:12vh 16px 16px'].join(';'));
    ov.id = 'pls-sr-ov';
    var box = el('div', ['width:100%', 'max-width:560px', 'background:' + sur, 'color:' + text,
      'border:1px solid ' + line, 'border-radius:14px', 'box-shadow:0 24px 70px rgba(0,0,0,.35)',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif', 'overflow:hidden', 'display:flex', 'flex-direction:column', 'max-height:72vh'].join(';'));
    var head = el('div', ['display:flex', 'align-items:center', 'gap:8px', 'padding:12px 14px', 'border-bottom:1px solid ' + line].join(';'));
    head.appendChild(el('span', 'font-size:17px;opacity:.7', '🔍'));
    input = el('input');
    input.type = 'text';
    input.placeholder = 'Поиск: компания, сделка, модуль…';
    input.style.cssText = ['flex:1', 'border:0', 'outline:none', 'background:transparent', 'color:' + text,
      'font:inherit', 'font-size:16px', 'padding:4px 2px'].join(';');
    head.appendChild(input);
    var kbd = el('span', ['font-size:11px', 'color:' + sub, 'border:1px solid ' + line, 'border-radius:6px', 'padding:2px 6px', 'white-space:nowrap'].join(';'), 'Esc');
    head.appendChild(kbd);
    box.appendChild(head);
    listBox = el('div', ['overflow-y:auto', 'padding:6px'].join(';'));
    box.appendChild(listBox);
    ov.appendChild(box);
    document.body.appendChild(ov);

    input.addEventListener('input', onType);
    input.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeOverlay(); });
    setTimeout(function () { input.focus(); }, 20);
    // Стартовый экран — модули (быстрый переход). Доступ может ещё грузиться → перерисуем.
    if (allowed === null) loadAccess().then(function () { if (ov) { buildLocal(input.value.trim()); render(); } });
    buildLocal(''); render();
  }

  function closeOverlay() { if (ov) { ov.remove(); ov = null; input = null; listBox = null; items = []; sel = 0; } }

  function onType() {
    var q = input.value.trim();
    buildLocal(q);
    render();
    if (debTimer) clearTimeout(debTimer);
    if (q.length >= 2) {
      var my = ++token;
      debTimer = setTimeout(function () {
        fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { if (my !== token || !ov) return; mergeRemote(d); render(); })
          .catch(function () {});
      }, 200);
    }
  }

  var localItems = [], remoteItems = [];
  function buildLocal(q) {
    var mods = allowedModules();
    var ql = q.toLowerCase();
    var matched = q ? mods.filter(function (m) { return m.n.toLowerCase().indexOf(ql) >= 0 || m.c.toLowerCase().indexOf(ql) >= 0; }) : mods;
    localItems = matched.map(function (m) { return { group: 'Модули', icon: '⚡', label: m.n, sub: '', href: m.h, external: false }; });
    remoteItems = []; // сбрасываем прошлые сущности при каждом новом вводе
  }
  function mergeRemote(d) {
    var r = [];
    if (d && d.companies) d.companies.forEach(function (c) {
      r.push({ group: 'Компании', icon: '🏢', label: c.title, sub: [c.industry, c.city, c.dealCount ? (c.dealCount + ' сделок') : ''].filter(Boolean).join(' · '), href: c.url, external: true });
    });
    if (d && d.deals) d.deals.forEach(function (x) {
      r.push({ group: 'Сделки', icon: '💼', label: x.title, sub: [x.company, x.sum ? mln(x.sum) : ''].filter(Boolean).join(' · '), href: x.url, external: true });
    });
    if (d && d.tickets) d.tickets.forEach(function (x) {
      r.push({ group: 'Заявки', icon: '🛠', label: (x.isOverdue ? '⏰ ' : '') + x.title, sub: [x.stageName, x.engineer].filter(Boolean).join(' · '), href: x.url, external: true });
    });
    remoteItems = r;
  }

  function render() {
    if (!listBox) return;
    var sur2 = cssVar('--surface-2', '#f1f3f6'), sub = cssVar('--text-3', '#6a7488'), accent = cssVar('--accent', '#C53B2F'), line = cssVar('--line', '#e7eaf0');
    items = localItems.concat(remoteItems);
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    if (!items.length) {
      listBox.innerHTML = '<div style="padding:22px 14px;text-align:center;color:' + sub + ';font-size:14px">' +
        (input && input.value.trim().length >= 2 ? 'Ничего не найдено' : 'Начните вводить название') + '</div>';
      return;
    }
    var html = '', lastGroup = null;
    items.forEach(function (it, i) {
      if (it.group !== lastGroup) {
        html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:' + sub + ';padding:10px 10px 4px">' + esc(it.group) + '</div>';
        lastGroup = it.group;
      }
      var on = i === sel;
      html += '<div data-i="' + i + '" class="pls-sr-row" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px;cursor:pointer;' +
        (on ? 'background:' + sur2 : '') + '">' +
        '<span style="font-size:15px;flex:none;width:20px;text-align:center">' + it.icon + '</span>' +
        '<span style="flex:1;min-width:0"><span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px">' + esc(it.label) + '</span>' +
        (it.sub ? '<span style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:' + sub + '">' + esc(it.sub) + '</span>' : '') +
        '</span>' + (it.external ? '<span style="color:' + sub + ';font-size:12px;flex:none">↗</span>' : '') + '</div>';
    });
    listBox.innerHTML = html;
    Array.prototype.forEach.call(listBox.querySelectorAll('.pls-sr-row'), function (row) {
      row.addEventListener('mouseenter', function () { sel = parseInt(row.getAttribute('data-i'), 10); paint(); });
      row.addEventListener('click', function () { sel = parseInt(row.getAttribute('data-i'), 10); openSel(); });
    });
  }
  function paint() {
    var sur2 = cssVar('--surface-2', '#f1f3f6');
    Array.prototype.forEach.call(listBox.querySelectorAll('.pls-sr-row'), function (row) {
      var on = parseInt(row.getAttribute('data-i'), 10) === sel;
      row.style.background = on ? sur2 : '';
    });
    var cur = listBox.querySelector('.pls-sr-row[data-i="' + sel + '"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }
  function openSel() {
    var it = items[sel]; if (!it || !it.href) return;
    if (it.external) { window.open(it.href, '_blank', 'noopener'); closeOverlay(); }
    else { closeOverlay(); window.location.href = it.href; }
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; paint(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; paint(); } }
    else if (e.key === 'Enter') { e.preventDefault(); openSel(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); }
  }

  // Горячая клавиша Ctrl/Cmd+K (и закрытие по той же комбинации).
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'л' || e.key === 'Л')) {
      e.preventDefault();
      if (ov) closeOverlay(); else openOverlay();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountButton);
  else mountButton();
})();

/* Онбординг-тур (приветствие на портале, один раз) + контекстные подсказки «?».
   Самодостаточно, без зависимостей; тема из cup-ui переменных (с фолбэками).
   Флаг «видел тур» хранится в user_prefs (ключ tour_seen) — переживает устройства. */
(function () {
  'use strict';
  if (window.__plsTour) return; window.__plsTour = true;

  // Краткая справка по страницам (тексты — из описаний модулей на портале).
  var HELP = {
    '/portal.html': { n: 'Главная ЦУП', d: 'Все доступные вам модули, «Мой день» со сводкой и глобальный поиск (🔍 или Ctrl+K). Начните отсюда — это ваш рабочий центр.' },
    '/account.html': { n: 'Мой кабинет', d: 'Имя, пароль, двухфакторная аутентификация, привязка Telegram для личных уведомлений и ваш журнал действий.' },
    '/planner.html': { n: 'Планировщик', d: 'Календарь занятости инженеров, выезды и командировки, синхронизация с заявками Bitrix.' },
    '/index.html': { n: 'Сервисные заявки', d: 'Учёт и обработка заявок на сервисное обслуживание оборудования.' },
    '/equipment-map.html': { n: 'Карта оборудования', d: 'География установленного оборудования клиентов по всей стране.' },
    '/licenses-map.html': { n: 'Карта лицензий ГМК', d: 'Реестр недропользователей и лицензий на добычу.' },
    '/relations.html': { n: 'Связи сделок', d: 'Иерархия сделок и смарт-процессов CRM по клиенту.' },
    '/mail.html': { n: 'Почта', d: 'Учёт и классификация писем по ящикам, контроль ответов клиентам.' },
    '/kp-hub.html': { n: 'Коммерческие предложения', d: 'Два подмодуля: МЛК (сборка КП по категориям от экспертов) и Сервис (конструктор сервисных КП и таргетинг «кому предложить сервис»).' },
    '/kp.html': { n: 'КП · МЛК', d: 'Сборка коммерческого предложения по категориям от экспертов.' },
    '/kp-service.html': { n: 'КП · Сервис', d: 'Конструктор сервисных КП и таргетинг по установочной базе.' },
    '/bonus.html': { n: 'Бонусы инженеров', d: 'Квартальный расчёт бонусов по сервисным контрактам и установкам.' },
    '/stats.html': { n: 'Статистика', d: 'Сводная статистика продаж по производителям, менеджерам и приборам.' },
    '/contracts.html': { n: 'Контракты', d: 'Портфель контрактов: структура по услугам, выполнение плана, детали по стадиям, помесячная и накопительная динамика.' },
    '/finance-debt.html': { n: 'Дебет', d: 'Дебиторская задолженность из 1С (счёт 1210): договоры с долгом и просрочкой, сводка по отделам.' },
    '/finance-stock.html': { n: 'Склад', d: 'Остатки на складах из 1С: номенклатура, количество, цена, сумма, срок годности, полка, ГТД. Фильтры по заказу/производителю/складу.' },
    '/finance-quality.html': { n: 'Качество', d: 'Сверка контрактов 1С и сделок Битрикса по ID: расхождения сумм/наименований/отделов, «сироты» и договоры без привязки.' },
    '/finance-advances.html': { n: 'Авансы', d: 'Авансы из 1С (3510) и оплаты по договорам: дерево год → отдел → контрагент → договор, Сумма / Авансы / Оплаты / Остаток.' },
    '/finance-cashflow.html': { n: 'Cash Flow', d: '13-недельный прогноз ликвидности: ожидаемые поступления по срокам оплаты, кривая остатка денег и кассовые разрывы заранее.' },
    '/companies.html': { n: 'Компании', d: 'Единый реестр компаний Б24: правка сферы и названия прямо из ЦУП с записью в Битрикс, поиск проблемных карточек (без сферы, без БИН, дубли).' },
    '/plansales.html': { n: 'План продаж', d: 'Незаконтрактованный pipeline (P10–P80) по сроку покупки: сводка по месяцам, отделам и менеджерам, горячие сделки (P80).' },
    '/nct.html': { n: 'НКТ', d: 'Регистрация товаров в Национальном каталоге: мастер (наименование → партномер → дубли → краткое/каз. имя → ОКТРУ) и получение NTIN/KZTIN.' },
    '/projects.html': { n: 'Проекты КАМ', d: 'Модель КАМ: Компания → Проект → КАМ → сделки. Привязка по полю «В рамках проекта», срезы до- и после-контракта, назначение КАМ.' },
    '/logistics.html': { n: 'Логистика', d: 'Отслеживание заказанных приборов в пути: где летит заказ, ETA, таможня, склад, доставка, трек-номера.' },
    '/operational.html': { n: 'Реализация', d: 'Операционный контроль сделок после подписания: воронка исполнения, смарт-процессы, задачи и сроки.' },
    '/procurement.html': { n: 'Закупки', d: 'Дашборд менеджера склада: заявки на закупки, синхронизация со смарт-процессом «Закупки», привязка к сделке, согласование оплат и приёмка.' },
    '/campaigns.html': { n: 'Рассылки', d: 'Массовые письма клиентам: выбор компаний по сфере, выбор адресов, шаблон, отправка через Resend с отпиской и стоп-листом.' },
    '/admin.html': { n: 'Управление', d: 'Пользователи, роли доступа к модулям и журнал действий в системе.' }
  };

  function cssVar(n, d) { try { var v = getComputedStyle(document.documentElement).getPropertyValue(n); return v && v.trim() ? v.trim() : d; } catch (e) { return d; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }); }
  function pagePath() { var p = (location.pathname || '/').replace(/\/+$/, ''); if (p === '' || p === '/index' ) p = (p === '/index') ? '/index.html' : '/portal.html'; return p; }
  function isPortal() { var p = pagePath(); return p === '/portal.html' || p === '/'; }

  // ── Контекстная «?» ──
  function mountHelpButton() {
    if (document.getElementById('pls-help-btn')) return;
    var b = document.createElement('button');
    b.id = 'pls-help-btn';
    b.textContent = '?';
    b.title = 'Что это за раздел';
    b.setAttribute('aria-label', b.title);
    b.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:128px', 'z-index:2147483600',
      'width:44px', 'height:44px', 'border-radius:50%', 'cursor:pointer',
      'background:var(--surface,#fff)', 'color:var(--text,#101624)',
      'border:1px solid var(--line-2,#d6dbe4)', 'box-shadow:0 4px 14px rgba(0,0,0,.18)',
      'font-size:20px', 'font-weight:800', 'line-height:44px', 'padding:0'
    ].join(';');
    b.addEventListener('click', openHelp);
    document.body.appendChild(b);
  }

  function openHelp() {
    if (document.getElementById('pls-help-ov')) return;
    var sur = cssVar('--surface', '#fff'), text = cssVar('--text', '#101624'), line = cssVar('--line', '#e7eaf0'),
        sub = cssVar('--text-3', '#6a7488'), accent = cssVar('--accent', '#C53B2F');
    var info = HELP[pagePath()] || { n: 'Раздел ЦУП', d: 'Рабочий раздел ЦУП. Если что-то непонятно — нажмите 💬 и спросите команду.' };
    var ov = document.createElement('div');
    ov.id = 'pls-help-ov';
    ov.style.cssText = ['position:fixed', 'inset:0', 'z-index:2147483603', 'background:rgba(0,0,0,.38)',
      'display:flex', 'align-items:center', 'justify-content:center', 'padding:16px'].join(';');
    var box = document.createElement('div');
    box.style.cssText = ['width:100%', 'max-width:440px', 'background:' + sur, 'color:' + text,
      'border:1px solid ' + line, 'border-radius:16px', 'padding:18px 18px 16px',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif', 'box-shadow:0 20px 60px rgba(0,0,0,.3)'].join(';');
    box.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
        '<span style="font-size:20px">💡</span><b style="font-size:16px">' + esc(info.n) + '</b>' +
        '<span style="flex:1"></span>' +
        '<button id="pls-help-x" style="background:none;border:0;color:' + sub + ';font-size:20px;cursor:pointer;line-height:1">×</button>' +
      '</div>' +
      '<div style="font-size:14px;line-height:1.5;color:' + text + '">' + esc(info.d) + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:16px">' +
        (isPortal() ? '<button id="pls-help-tour" style="background:' + accent + ';border:0;border-radius:9px;color:#fff;font:inherit;font-weight:700;font-size:13px;padding:8px 14px;cursor:pointer">Пройти обзор</button>' : '') +
        '<span style="flex:1"></span>' +
        '<button id="pls-help-ok" style="background:none;border:1px solid ' + line + ';border-radius:9px;color:' + text + ';font:inherit;font-weight:600;font-size:13px;padding:8px 14px;cursor:pointer">Понятно</button>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);
    function close() { ov.remove(); }
    box.querySelector('#pls-help-x').addEventListener('click', close);
    box.querySelector('#pls-help-ok').addEventListener('click', close);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    var t = box.querySelector('#pls-help-tour');
    if (t) t.addEventListener('click', function () { close(); startTour(); });
  }

  // ── Тур (спотлайт) ──
  var steps = [], idx = 0, root = null;
  function buildSteps() {
    var defs = [
      { sel: '.hero', title: 'Добро пожаловать в ЦУП!', text: 'Это ваш рабочий центр. Пара шагов — и покажу главное.' },
      { sel: '.grid', title: 'Ваши модули', text: 'Здесь инструменты, к которым у вас есть доступ. Клик по карточке — и вы внутри.' },
      { sel: '#myday', title: 'Мой день', text: 'Ваши сделки, активные заявки и просроченные задачи — сразу на входе.' },
      { sel: '#pls-sr-btn', title: 'Поиск по всему ЦУП', text: 'Нажмите 🔍 или Ctrl+K в любом месте — ищите компании, сделки и модули.' },
      { sel: '#pls-fb-btn', title: 'Обратная связь', text: 'Нашли проблему или есть идея? Жмите 💬 — всё увидит команда.' }
    ];
    return defs.filter(function (s) {
      var e = document.querySelector(s.sel);
      return e && (e.offsetWidth > 0 || e.offsetHeight > 0 || e.getClientRects().length);
    });
  }

  function startTour() {
    if (root) return;
    steps = buildSteps();
    if (!steps.length) return;
    idx = 0;
    root = document.createElement('div');
    root.id = 'pls-tour';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483610;';
    var hole = document.createElement('div');
    hole.id = 'pls-tour-hole';
    hole.style.cssText = 'position:absolute;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.6);transition:all .2s ease;pointer-events:none;';
    var tip = document.createElement('div');
    tip.id = 'pls-tour-tip';
    root.appendChild(hole); root.appendChild(tip);
    document.body.appendChild(root);
    window.addEventListener('resize', position);
    document.addEventListener('keydown', onKey, true);
    showStep();
  }
  function endTour(markSeen) {
    if (!root) return;
    window.removeEventListener('resize', position);
    document.removeEventListener('keydown', onKey, true);
    root.remove(); root = null;
    if (markSeen) {
      try { fetch('/api/account/prefs/tour_seen', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: true }) }); } catch (e) {}
    }
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); endTour(true); } }

  function showStep() {
    var s = steps[idx], el = document.querySelector(s.sel);
    if (!el) { if (idx < steps.length - 1) { idx++; return showStep(); } return endTour(true); }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(position, 220);
  }
  function position() {
    if (!root) return;
    var s = steps[idx], el = document.querySelector(s.sel);
    if (!el) return;
    var r = el.getBoundingClientRect(), pad = 8;
    var hole = document.getElementById('pls-tour-hole');
    hole.style.top = (r.top - pad) + 'px'; hole.style.left = (r.left - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px'; hole.style.height = (r.height + pad * 2) + 'px';

    var sur = cssVar('--surface', '#fff'), text = cssVar('--text', '#101624'), line = cssVar('--line', '#e7eaf0'),
        sub = cssVar('--text-3', '#6a7488'), accent = cssVar('--accent', '#C53B2F');
    var tip = document.getElementById('pls-tour-tip');
    tip.style.cssText = ['position:absolute', 'max-width:300px', 'width:calc(100vw - 32px)', 'box-sizing:border-box',
      'background:' + sur, 'color:' + text, 'border:1px solid ' + line, 'border-radius:12px', 'padding:14px 16px',
      'box-shadow:0 16px 50px rgba(0,0,0,.4)', 'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif', 'pointer-events:auto'].join(';');
    tip.innerHTML =
      '<div style="font-size:15px;font-weight:800;margin-bottom:4px">' + esc(s.title) + '</div>' +
      '<div style="font-size:13.5px;line-height:1.5;color:' + text + '">' + esc(s.text) + '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:14px">' +
        '<span style="font-size:12px;color:' + sub + '">' + (idx + 1) + ' / ' + steps.length + '</span>' +
        '<span style="flex:1"></span>' +
        '<button id="pls-tour-skip" style="background:none;border:0;color:' + sub + ';font:inherit;font-size:12.5px;cursor:pointer">Пропустить</button>' +
        (idx > 0 ? '<button id="pls-tour-prev" style="background:none;border:1px solid ' + line + ';border-radius:8px;color:' + text + ';font:inherit;font-weight:600;font-size:12.5px;padding:6px 10px;cursor:pointer">Назад</button>' : '') +
        '<button id="pls-tour-next" style="background:' + accent + ';border:0;border-radius:8px;color:#fff;font:inherit;font-weight:700;font-size:12.5px;padding:6px 12px;cursor:pointer">' + (idx === steps.length - 1 ? 'Готово' : 'Далее') + '</button>' +
      '</div>';

    // Разместить тултип: снизу от выделения, иначе сверху; по горизонтали прижать к краю выделения и зажать в экран.
    var vw = window.innerWidth, vh = window.innerHeight;
    tip.style.visibility = 'hidden'; tip.style.top = '0px'; tip.style.left = '0px';
    var th = tip.offsetHeight, tw = tip.offsetWidth;
    var top = r.bottom + pad + 10; if (top + th > vh - 8) top = r.top - pad - 10 - th; if (top < 8) top = 8;
    var left = Math.min(Math.max(r.left, 8), vw - tw - 8);
    tip.style.top = top + 'px'; tip.style.left = left + 'px'; tip.style.visibility = 'visible';

    tip.querySelector('#pls-tour-skip').addEventListener('click', function () { endTour(true); });
    tip.querySelector('#pls-tour-next').addEventListener('click', function () { if (idx === steps.length - 1) endTour(true); else { idx++; showStep(); } });
    var pv = tip.querySelector('#pls-tour-prev'); if (pv) pv.addEventListener('click', function () { idx--; showStep(); });
  }

  // ── Автозапуск тура на портале при первом входе ──
  function maybeAutoTour() {
    if (!isPortal()) return;
    fetch('/api/account/prefs/tour_seen', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.value === true) return; setTimeout(function () { if (!root) startTour(); }, 1200); })
      .catch(function () {});
  }

  function init() { mountHelpButton(); maybeAutoTour(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

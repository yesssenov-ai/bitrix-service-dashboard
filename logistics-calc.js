// Питает модуль «Логистика». Один заказ = одна закупка (смарт «Закупки» 1066).
// Путь заказа собирается сквозняком по трём процессам Bitrix:
//   Закупки (1066)  →  Логистика (1070, дочка закупки по parentId1066)  →  Сделка
// Стадия/отдел/менеджер/производитель сделки берём из готового зеркала
// ticketsmodule_stat_deals (быстро, без лишних вызовов Bitrix). Закупку и её
// логистическую заявку тянем живьём (кэш 10 мин).
const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const { USERS } = require('./constants');

// ── Отделы (как в остальных модулях) ────────────────────────────────────────
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'ОРМ', '4863': 'Service',
  '4864': 'Training', '4865': 'General Lab', '4866': 'Complex', '8384': 'Материаловедение',
};
const PIPE_SHORT = { 0: 'Inst', 1: 'ОРМ', 2: 'Training', 3: 'Service' };
function saleType(categoryId, deptId) {
  const dep = DEPARTMENT_LABELS[deptId];
  const merged = (dep === 'Хроматография' || dep === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : dep;
  return merged || PIPE_SHORT[categoryId] || 'Прочее';
}

// ── 11 канонических вех (6+7 и 8+9 объединены по согласованию) ───────────────
const MILESTONES = [
  { i: 1, key: 'placed',        label: 'Заказ размещён',              phase: 'purchase', icon: '📝', short: 'Заказ' },
  { i: 2, key: 'awaiting_pay',  label: 'Ожидает оплаты поставщику',   phase: 'purchase', icon: '⏳', short: 'Предоплата' },
  { i: 3, key: 'paid',          label: 'Оплачен',                     phase: 'purchase', icon: '💳', short: 'Оплачен' },
  { i: 4, key: 'awaiting_ship', label: 'Ожидание отгрузки',           phase: 'purchase', icon: '📦', short: 'Ждём отгр.' },
  { i: 5, key: 'in_transit',    label: 'Отгружен / В пути',           phase: 'transit',  icon: '🛫', short: 'Отгружен' },
  { i: 6, key: 'customs',       label: 'Прибыл в страну · Таможня',    phase: 'customs',  icon: '🛃', short: 'Таможня' },
  { i: 7, key: 'warehouse',     label: 'Выпущен · Прибыл на склад',    phase: 'customs',  icon: '🏬', short: 'Наш склад' },
  { i: 8, key: 'prep_ship',     label: 'Подготовка к отгрузке',       phase: 'domestic', icon: '🧰', short: 'Подготовка' },
  { i: 9, key: 'sent_client',   label: 'Отправлен заказчику',         phase: 'domestic', icon: '🚚', short: 'Клиенту' },
  { i: 10, key: 'install',      label: 'Установка',                   phase: 'domestic', icon: '🔧', short: 'Монтаж' },
  { i: 11, key: 'docs',         label: 'Документы и оплата',          phase: 'domestic', icon: '📄', short: 'Док-ты' },
];
const PHASE_COLOR = { purchase: '#ffb020', transit: '#5b8cff', customs: '#a56bff', domestic: '#22c9a3' };
// Три смысловые секции пути
const SECTIONS = [
  { key: 'import',   label: 'Путь до нашего склада',    from: 1, to: 7,  color: '#5b8cff' },
  { key: 'dispatch', label: 'Склад → отправка клиенту', from: 8, to: 9,  color: '#22c9a3' },
  { key: 'closeout', label: 'Установка и закрытие',      from: 10, to: 11, color: '#3ddc97' },
];

// Стадия Закупки → веха
const PURCH_MS = {
  'DT1066_13:NEW': 1, 'DT1066_13:PREPARATION': 1, 'DT1066_13:CLIENT': 1,
  'DT1066_13:1': 2, 'DT1066_13:2': 3, 'DT1066_13:UC_QO83IP': 4, 'DT1066_13:UC_ZGC0GD': 4,
  'DT1066_13:4': 5, 'DT1066_13:5': 5, 'DT1066_13:3': 5, 'DT1066_13:SUCCESS': 6,
};
// Стадия Логистики → веха (6/7 объединённые)
const LOGI_MS = {
  'DT1070_14:NEW': 6, 'DT1070_14:PREPARATION': 6, 'DT1070_14:CLIENT': 6,
  'DT1070_14:1': 7, 'DT1070_14:SUCCESS': 7,
};
// Доменная стадия сделки → веха (все воронки; префиксы C1:/C2:/C3: снимаем)
const DEAL_MS_BASE = {
  'UC_Q9J6VV': 8, 'UC_3MVK90': 8,       // Подготовка к отгрузке
  'UC_9MBFR2': 9, 'UC_3SCB5K': 9,       // Готов к отгрузке → отправлен заказчику
  '2': 10,                               // Installation
  '3': 11, 'WON': 11,                    // Money/Document → завершена
};
function dealMs(stageId) {
  if (!stageId) return 0;
  const bare = stageId.replace(/^C\d:/, '');
  return DEAL_MS_BASE[bare] || 0;
}
const FAIL_PURCH = new Set(['DT1066_13:FAIL', 'DT1066_13:6']);

// Два РАЗНЫХ срока:
//  • Транзит — сколько прибор реально идёт от завода (двигаем самолёт). ~15 дней.
//  • Договорной срок (SLA) — за сколько обязаны привезти клиенту ОТ ДАТЫ ПОДПИСАНИЯ
//    контракта: 90 дней обычно, 180 для лицензируемых (двойное назначение / рентген).
const TRANSIT_DAYS = 15;
const CONTRACT_DAYS = 90, CONTRACT_DAYS_LIC = 180;
const LICENSED_RE = /icp\s*-?\s*ms|aeris|\bxrd\b|\bxrf\b|рентген|x-?ray/i;

// ── Поля смарт-процессов (из discovery-probe) ───────────────────────────────
const F1066 = {
  ship: 'ufCrm10_1732858508586',        // Дата отгрузки от завода
  track: 'ufCrm10_1732858436450',       // Трек-номер
  trackUrl: 'ufCrm10_1732858524962',    // Трек номер заказа от завода (url)
  needInstall: 'ufCrm10_1732858371116', // Требуется установка
  cityCountry: 'ufCrm10_1764043678827', // Город / Область / Страна
  po: 'ufCrm10_1763536157575',          // Номер PO
};
const F1070 = {
  track: 'ufCrm11_1732865717409',       // Трек-номер
  carrier: 'ufCrm11_1732866072',        // Перевозчик (crm)
  customsExpected: 'ufCrm11_1732866287827', // Ожидаемая дата таможенной очистки
  postedDate: 'ufCrm11_1732866384410',  // Дата оприходования
  warehouseDate: 'ufCrm11_1732866412851', // Дата поступления на склад
  po: 'ufCrm11_1763537575780',          // Номер PO
};
// Файлы-документы: [подпись, код поля]. Показываем как кнопки в карточке.
const DOCS_1066 = [
  ['Invoice', 'ufCrm10_1763537277532'],
  ['Proforma', 'ufCrm10_1763547107682'],
  ['Packing List / Customs', 'ufCrm10_1732858448434'],
  ['Договор / Спецификация', 'ufCrm10_1732858619051'],
  ['Тех. описание', 'ufCrm10_1763550466425'],
];
const DOCS_1070 = [
  ['Таможенная декларация', 'ufCrm11_1732866302418'],
  ['Документы для таможни', 'ufCrm11_1732866046625'],
  ['Накладная', 'ufCrm11_1744028435403'],
  ['Доверенность', 'ufCrm11_1744028340187'],
  ['Сопроводительные', 'ufCrm11_1732866398354'],
  // «Пакинг-лист» (1070) убран — дублирует «Packing List / Customs» из закупки (1066).
];
const fileUrl = v => { if (!v) return null; const f = Array.isArray(v) ? v[0] : v; return (f && (f.url || f.urlMachine || f.downloadUrl)) || null; };

// contract_date из pg приходит объектом Date, а даты из crm.item.list — строкой.
const ymd = v => { if (v == null) return null; if (v instanceof Date) return v.toISOString().slice(0, 10); const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; };
const dayMs = 86400000;
// Базы ссылок в Bitrix (из вебхука): сделка и элемент смарт-процесса «Закупки».
function bitrixOrigin() { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return null; } }
function addDays(ymdStr, n) {
  const d = new Date(ymdStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / dayMs); }

// ── Живой список элементов смарт-процесса (пагинация) ───────────────────────
async function itemList(entityTypeId, categoryId, select) {
  let items = [], start = 0;
  while (true) {
    const { result } = await b24('crm.item.list', { entityTypeId, filter: { categoryId }, select, start });
    const batch = (result && result.items) || [];
    items = items.concat(batch);
    const total = result && result.total;
    start += batch.length;
    if (!batch.length || (total != null && start >= total) || batch.length < 50) break;
    if (start > 5000) break; // предохранитель
  }
  return items;
}

// Имена сотрудников, которых нет в статичном списке USERS (напр. #49/#66/#92) —
// достаём из Bitrix (user.get) и кэшируем в процессе. Иначе показываются как «#id».
const userNameCache = {};
async function resolveUserNames(ids) {
  for (const id of [...new Set(ids.filter(Boolean).map(Number))]) {
    if (USERS[id] || userNameCache[id] !== undefined) continue;
    try {
      const { result } = await b24('user.get', { ID: id });
      const u = (result || [])[0];
      userNameCache[id] = u ? ([u.LAST_NAME, u.NAME].filter(Boolean).join(' ').trim() || u.EMAIL || ('#' + id)) : null;
    } catch (e) { userNameCache[id] = null; }
  }
}
const uname = id => id ? (USERS[id] || userNameCache[id] || ('#' + id)) : null;

// ── История стадий (когда сущность зашла в каждую стадию), фильтр по OWNER_ID ──
async function fetchHistory(entityTypeId, ownerIds) {
  const byOwner = {};
  const ids = [...new Set(ownerIds.map(Number).filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    let start = 0;
    while (true) {
      const { result, total } = await b24('crm.stagehistory.list', { entityTypeId, filter: { OWNER_ID: chunk }, order: { ID: 'ASC' }, start });
      const items = (result && result.items) || [];
      items.forEach(h => { const o = String(h.OWNER_ID); (byOwner[o] = byOwner[o] || []).push({ stage: h.STAGE_ID, at: h.CREATED_TIME }); });
      start += items.length;
      if (!items.length || (total != null && start >= total) || items.length < 50) break;
      if (start > 30000) break;
    }
  }
  return byOwner;
}
const isoToYmd = s => s ? String(s).slice(0, 10) : null;
function daysBetweenIso(a, b) { return Math.max(0, Math.round((new Date(b) - new Date(a)) / dayMs)); }

// ── Обогащение из зеркала сделок ────────────────────────────────────────────
async function dealMapFor(dealIds) {
  if (!dealIds.length) return {};
  const { rows } = await pool.query(
    `SELECT deal_id, category_id, stage_id, department_id, assigned_by_id, manufacturer, instrument_name, deal_title, company_id, contract_date
       FROM ticketsmodule_stat_deals WHERE deal_id = ANY($1)`, [dealIds]);
  const map = {};
  rows.forEach(d => { map[d.deal_id] = d; });
  return map;
}

let boardCache = null, boardAt = 0, _refreshP = null;
async function computeBoard() {
  // 1) Закупки (активные — без FAIL/переноса плановой даты как отдельного «провала»)
  const purch = await itemList(1066, 13, ['id', 'title', 'stageId', 'movedTime', 'assignedById', 'parentId2',
    'opportunity', 'currencyId', 'begindate', 'closedate', F1066.ship, F1066.track, F1066.trackUrl, F1066.needInstall, F1066.cityCountry, F1066.po,
    ...DOCS_1066.map(d => d[1])]);

  // 2) Логистика → индекс по parentId1066 (id закупки)
  const logi = await itemList(1070, 14, ['id', 'title', 'stageId', 'movedTime', 'assignedById', 'parentId2', 'parentId1066',
    F1070.track, F1070.carrier, F1070.customsExpected, F1070.postedDate, F1070.warehouseDate, F1070.po,
    ...DOCS_1070.map(d => d[1])]);
  const logiByPurch = {};
  logi.forEach(l => { const pid = l.parentId1066; if (pid) logiByPurch[String(pid)] = l; });

  // 3) Данные сделок из зеркала
  const dealIds = [...new Set(purch.map(p => Number(p.parentId2)).filter(Boolean))];
  const deals = await dealMapFor(dealIds);

  // 4) История стадий трёх процессов (для длительности этапов)
  const [histDeal, histPurch, histLogi] = await Promise.all([
    fetchHistory(2, dealIds),
    fetchHistory(1066, purch.map(p => p.id)),
    fetchHistory(1070, logi.map(l => l.id)),
  ]);
  const nowIso = new Date().toISOString();

  // Дорезолвим имена ответственных, которых нет в статичном USERS.
  await resolveUserNames([...purch.map(p => p.assignedById), ...Object.values(deals).map(d => d.assigned_by_id)]);

  const today = new Date().toISOString().slice(0, 10);

  const orders = purch
    .filter(p => !FAIL_PURCH.has(p.stageId))
    .map(p => {
      const l = logiByPurch[String(p.id)] || null;
      const deal = deals[Number(p.parentId2)] || null;
      const dealStage = deal ? deal.stage_id : null;

      // текущая веха = максимум по трём процессам + факт отгрузки/склада
      let ms = PURCH_MS[p.stageId] || 0;
      const shipDate = ymd(p[F1066.ship]);
      if (shipDate) ms = Math.max(ms, 5);
      if (l) ms = Math.max(ms, LOGI_MS[l.stageId] || 0);
      const warehouseDate = l ? ymd(l[F1070.warehouseDate]) || ymd(l[F1070.postedDate]) : null;
      if (warehouseDate) ms = Math.max(ms, 7);
      ms = Math.max(ms, dealMs(dealStage));
      if (ms === 0) ms = 1;

      const done = ms >= 11;
      const mdef = MILESTONES.find(m => m.i === ms) || MILESTONES[0];
      const instrument = deal ? (deal.instrument_name || '') : '';
      const manufacturer = deal ? (deal.manufacturer || '') : '';
      const licensed = LICENSED_RE.test(instrument + ' ' + (p.title || ''));

      // ── Транзит (самолёт): ~15 дней от даты отгрузки завода ──
      let transitEta = null, progress = 0, transitElapsed = null, transitLeft = null;
      if (shipDate) {
        transitEta = addDays(shipDate, TRANSIT_DAYS);
        transitElapsed = Math.max(0, daysBetween(shipDate, today));
        transitLeft = daysBetween(today, transitEta);
        progress = ms > 5 ? 1 : Math.max(0, Math.min(1, transitElapsed / TRANSIT_DAYS));
      }
      const arrivingSoon = ms === 5 && transitLeft != null && transitLeft >= 0 && transitLeft <= 3;

      // ── Договорной срок (SLA): дата подписания + 90/180 ──
      const contractDate = deal ? ymd(deal.contract_date) : null;
      const contractDays = licensed ? CONTRACT_DAYS_LIC : CONTRACT_DAYS;
      let deadline = null, deadlineLeft = null, deadlineOverdue = false, deadlineSoon = false;
      if (contractDate && !done) {
        deadline = addDays(contractDate, contractDays);
        deadlineLeft = daysBetween(today, deadline);
        deadlineOverdue = deadlineLeft < 0;
        deadlineSoon = deadlineLeft >= 0 && deadlineLeft <= 14;
      }

      // ── Даты захода в каждую веху (слив истории трёх процессов) + длительности ──
      const msDates = {};
      const consider = (arr, mapper) => (arr || []).forEach(h => {
        const mi = mapper(h.stage); if (!mi) return;
        if (!msDates[mi] || new Date(h.at) < new Date(msDates[mi])) msDates[mi] = h.at;
      });
      consider(histPurch[String(p.id)], s => PURCH_MS[s] || 0);
      if (l) consider(histLogi[String(l.id)], s => LOGI_MS[s] || 0);
      if (deal) consider(histDeal[String(deal.deal_id)], s => dealMs(s));
      // подстраховка точными полями-датами
      if (shipDate) msDates[5] = shipDate + 'T00:00:00+05:00';
      if (warehouseDate) msDates[7] = warehouseDate + 'T00:00:00+05:00';
      const reached = Object.keys(msDates).map(Number).sort((a, b) => a - b);
      const stageDurations = {}; // веха m → сколько дней провели на ней до перехода к следующей достигнутой
      for (let i = 0; i < reached.length - 1; i++) stageDurations[reached[i]] = daysBetweenIso(msDates[reached[i]], msDates[reached[i + 1]]);
      let currentStageDays = null;
      if (reached.length && !done) currentStageDays = daysBetweenIso(msDates[reached[reached.length - 1]], nowIso);
      const milestoneDates = {}; reached.forEach(m => milestoneDates[m] = isoToYmd(msDates[m]));

      const deptId = deal ? deal.department_id : null;
      const dept = deal ? saleType(deal.category_id, deptId) : 'Не указан';
      const mgrDeal = deal && deal.assigned_by_id ? uname(deal.assigned_by_id) : null;
      const mgrPurch = p.assignedById ? uname(p.assignedById) : null;
      const po = p[F1066.po] || (l && l[F1070.po]) || null;
      // Документы: НЕ кэшируем прямую ссылку Bitrix (подпись протухает → ошибка
      // «allowed_only_intranet_user»). Храним ссылку на сущность/поле, а скачивание
      // идёт через наш прокси /api/logistics/file, который берёт свежий URL на клик.
      const docs = [];
      DOCS_1066.forEach(([lbl, code]) => { if (fileUrl(p[code])) docs.push({ label: lbl, e: 1066, id: p.id, f: code }); });
      if (l) DOCS_1070.forEach(([lbl, code]) => { if (fileUrl(l[code])) docs.push({ label: lbl, e: 1070, id: l.id, f: code }); });

      // ── «Критический» кейс: горит по договору / застрял / просрочен транзит ──
      const stuck = !done && currentStageDays != null && currentStageDays >= 30;
      const transitOverdue = ms === 5 && transitLeft != null && transitLeft < 0;
      const critical = deadlineOverdue || deadlineSoon || arrivingSoon || transitOverdue || stuck;

      const o = bitrixOrigin();
      return {
        id: p.id, po,
        dealId: deal ? deal.deal_id : (p.parentId2 || null),
        dealTitle: deal ? (deal.deal_title || '') : '',
        purchUrl: o ? `${o}/crm/type/1066/details/${p.id}/` : null,
        dealUrl: o && deal ? `${o}/crm/deal/details/${deal.deal_id}/` : null,
        instrument, manufacturer,
        dept, licensed,
        managerDeal: mgrDeal, managerPurch: mgrPurch,
        dealRespId: deal && deal.assigned_by_id ? deal.assigned_by_id : null,
        purchRespId: p.assignedById ? parseInt(p.assignedById, 10) : null,
        milestone: ms, milestoneKey: mdef.key, milestoneLabel: mdef.label, phase: mdef.phase,
        purchStage: p.stageId, logiStage: l ? l.stageId : null, dealStage,
        shipDate, transitDays: TRANSIT_DAYS, transitEta, progress, transitElapsed, transitLeft, arrivingSoon,
        contractDate, contractDays, deadline, deadlineLeft, deadlineOverdue, deadlineSoon,
        milestoneDates, stageDurations, currentStageDays,
        customsExpected: l ? ymd(l[F1070.customsExpected]) : null,
        warehouseDate,
        tracking: (l && l[F1070.track]) || p[F1066.track] || null,
        trackingUrl: p[F1066.trackUrl] || null,
        carrierId: l ? (l[F1070.carrier] || null) : null,
        cityCountry: p[F1066.cityCountry] || null,
        done, stuck, transitOverdue, critical, docs,
        opportunity: parseFloat(p.opportunity) || 0,
        movedTime: (l && l.movedTime) || p.movedTime || null,
      };
    });

  // сортировка: сначала не завершённые и с ближайшим договорным дедлайном; завершённые вниз
  orders.sort((a, b) => (a.done - b.done) || ((a.deadlineLeft ?? 99999) - (b.deadlineLeft ?? 99999)) || (b.milestone - a.milestone));

  const board = {
    generatedAt: new Date().toISOString(),
    milestones: MILESTONES, phaseColor: PHASE_COLOR, sections: SECTIONS,
    orders,
    kpi: {
      total: orders.length,
      critical: orders.filter(o => o.critical).length,
      inTransit: orders.filter(o => o.milestone === 5).length,
      arrivingSoon: orders.filter(o => o.arrivingSoon).length,
      atCustoms: orders.filter(o => o.milestone === 6).length,
      atWarehouse: orders.filter(o => o.milestone === 7).length,
      overdue: orders.filter(o => o.deadlineOverdue).length,
      deadlineSoon: orders.filter(o => o.deadlineSoon).length,
      done: orders.filter(o => o.done).length,
    },
  };
  return board;
}

// refreshBoard — принудительный пересчёт с записью в кэш; параллельные вызовы
// (кнопка «Обновить» + фоновый таймер) переиспользуют один и тот же запуск.
function refreshBoard() {
  if (_refreshP) return _refreshP;
  _refreshP = computeBoard()
    .then(b => { boardCache = b; boardAt = Date.now(); return b; })
    .finally(() => { _refreshP = null; });
  return _refreshP;
}

// getBoard — отдаёт кэш МГНОВЕННО (не блокирует загрузку страницы тяжёлым
// пересчётом). Живой пересчёт только: (1) если кэша ещё нет — первый прогрев,
// (2) force=1 — кнопка «Обновить». В фоне кэш освежает планировщик (server.js).
async function getBoard(force) {
  if (force) return refreshBoard();
  if (boardCache) return boardCache;
  return refreshBoard();
}

// Белый список кодов файловых полей — только их разрешаем качать через прокси.
const FILE_FIELDS = new Set([...DOCS_1066.map(d => d[1]), ...DOCS_1070.map(d => d[1])]);

module.exports = { getBoard, refreshBoard, MILESTONES, FILE_FIELDS, fileUrl, bitrixOrigin };

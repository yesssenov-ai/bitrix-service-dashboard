// Новый расчётный слой Статистики (Фаза 1). Читает ВСЕ сделки из зеркала
// ticketsmodule_stat_deals, классифицирует по стадиям воронки и агрегирует
// по производителям, менеджерам, приборам, компаниям и сферам.
// Конверсии/тайминги (нужна история стадий) — Фаза 2.
const { pool } = require('./auth');
const { b24 } = require('./bitrix');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');

// Справочник сфер деятельности (INDUSTRY): Bitrix хранит код (напр. «3»), а имя
// берётся из статус-справочника. Кэш 6ч, коды → человеческие названия.
let _indMap = null, _indAt = 0;
async function getIndustryMap() {
  if (_indMap && Date.now() - _indAt < 6 * 3600 * 1000) return _indMap;
  const map = {};
  try {
    const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: 'INDUSTRY' } });
    (result || []).forEach(s => { map[String(s.STATUS_ID)] = s.NAME; });
  } catch (e) { /* best-effort — останутся коды */ }
  _indMap = map; _indAt = Date.now();
  return map;
}

// ── Стадии воронки (по выгрузке discover-stages, все 4 воронки) ───────────────
const RAW = {
  P10: ['NEW', 'C1:NEW', 'C2:NEW', 'C3:NEW'],
  P30: ['PREPARATION', 'C1:PREPARATION', 'C2:PREPARATION', 'C3:PREPARATION'],
  P60: ['PREPAYMENT_INVOICE', 'C1:PREPAYMENT_INVOICE', 'C2:PREPAYMENT_INVOICE', 'C3:PREPAYMENT_INVOICE'],
  P80: ['EXECUTING', 'C1:EXECUTING', 'C2:EXECUTING', 'C3:EXECUTING'],
  CONTRACT: ['FINAL_INVOICE', 'C1:FINAL_INVOICE', 'C2:FINAL_INVOICE', 'C3:FINAL_INVOICE'],
  EXEC: ['1', 'UC_Q9J6VV', 'UC_9MBFR2', '2', '3',
    'C1:1', 'C1:UC_3MVK90', 'C1:UC_3SCB5K', 'C1:2', 'C1:3',
    'C2:1', 'C2:2', 'C3:UC_YYTFYG', 'C3:2'],
  WON: ['WON', 'C1:WON', 'C2:WON', 'C3:WON'],
  LOSE: ['LOSE', 'C1:LOSE', 'C2:LOSE', 'C3:LOSE'],
  FROZEN: ['APOLOGY', 'C1:APOLOGY', 'C2:UC_IXKNOM', 'C3:UC_DWU581'],
};
const STAGE_STEP = {};
for (const [step, ids] of Object.entries(RAW)) ids.forEach(id => { STAGE_STEP[id] = step; });
const step = s => STAGE_STEP[s] || null;
const SOLD_STEPS = new Set(['CONTRACT', 'EXEC', 'WON']); // «Продано» / подписано = контракт и далее до завершения
const KP_STEPS = new Set(['P60', 'P80']);                // «Выдано КП»
const PRE_STEPS = new Set(['P10', 'P30', 'P60', 'P80']); // доконтрактные (в работе, ещё не подписаны)
const PRE_ORDER = ['P10', 'P30', 'P60', 'P80'];
const PRE_LABELS = { P10: 'P10 · Новый лид', P30: 'P30 · Задача принята', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес' };
const isSold = s => SOLD_STEPS.has(step(s));
const isKp = s => KP_STEPS.has(step(s));
const isPre = s => PRE_STEPS.has(step(s));
// 4 воронки Bitrix (по category_id): именно так, как просит бизнес — Сервис, а не «Услуги».
const FUNNEL = { 0: 'Приборы', 1: 'Расходники', 2: 'Обучение', 3: 'Сервис' };
const FUNNEL_ORDER = ['Приборы', 'Расходники', 'Сервис', 'Обучение'];
const funnelName = c => FUNNEL[c] || '—';

// Направление (Отдел) — для разрезов внутри продаж
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'Расходники', '4863': 'Сервис',
  '4864': 'Обучение', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const deptLabel = id => {
  const l = DEPARTMENT_LABELS[id] || id || 'Не указан';
  return (l === 'Хроматография' || l === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : l;
};
// Категория воронки → крупная группа (приборы/расходка/услуги/обучение)
const CAT_GROUP = { 0: 'Приборы', 1: 'Расходники', 2: 'Обучение', 3: 'Услуги' };
// «Направление» = поле «Отдел», КОГДА оно заполнено (тогда сделка идёт в свой
// отдел — напр. Материаловедение — в какой бы воронке ни была). Если «Отдел»
// пуст — падаем на короткое имя воронки (Расходники/Обучение/Сервис/Инструменты),
// иначе сервис/расходка с пустым отделом терялись бы в «Не указан».
// Это совпадает с логикой Power BI и с модулем «Контракты».
const PIPE_FALLBACK = { 0: 'Инструменты', 1: 'Расходники', 2: 'Обучение', 3: 'Сервис' };
const direction = (catId, departmentId) => {
  if (departmentId && DEPARTMENT_LABELS[departmentId]) return deptLabel(departmentId);
  return PIPE_FALLBACK[catId] || 'Не указан';
};

// Под-бренды → родительский бренд
const MANUF_GROUP = {
  'Agilent Technologies': 'Agilent', 'Agilent Cell Analysis': 'Agilent', 'Agilent Vacuum pump': 'Agilent',
  'Metrohm Autolab': 'Metrohm', 'Metrohm DropSens': 'Metrohm',
};
const manufParent = m => MANUF_GROUP[m] || m;

const uname = id => id ? (USERS[id] || `#${id}`) : '—';
// node-pg отдаёт колонки DATE как JS Date — приводим к строке 'YYYY-MM-DD' надёжно
// (String(dateObj).slice(0,10) давал бы «Thu Aug 13» и ломал фильтр по году).
const ymd = v => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
};
const yr = d => { if (!d) return null; const n = parseInt(String(d).slice(0, 4), 10); return Number.isNaN(n) ? null : n; };

// ── Общий загрузчик: читает зеркало сделок и обогащает (используется бордом и
// выгрузкой по сферам, чтобы логика классификации была одна). ─────────────────
async function loadEnriched() {
  const rate = await getTodayRate();
  const kzt = d => (d.currency_id === 'USD' ? (parseFloat(d.opportunity) || 0) * rate : (parseFloat(d.opportunity) || 0));
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_stat_deals');
  const indMap = await getIndustryMap();
  const enrich = d => ({
    id: d.deal_id, cat: d.category_id, stage: d.stage_id, step: step(d.stage_id),
    sum: kzt(d), dept: direction(d.category_id, d.department_id), catGroup: CAT_GROUP[d.category_id] || '—',
    funnel: funnelName(d.category_id),
    managerId: d.assigned_by_id, manager: uname(d.assigned_by_id),
    manufacturer: d.manufacturer && d.manufacturer !== 'Не определено' ? d.manufacturer : 'Не определено',
    instrument: d.instrument_name || '', title: d.deal_title || '',
    companyId: d.company_id, company: d.company_name || (d.company_id ? `Компания #${d.company_id}` : 'Без компании'),
    industry: (d.industry != null && d.industry !== '' ? (indMap[String(d.industry)] || String(d.industry)) : 'Не указана'),
    contractDate: ymd(d.contract_date),
    createDate: ymd(d.date_create),
  });
  return { rate, all: rows.map(enrich) };
}

// ── Основной расчёт борда за год(а) ──────────────────────────────────────────
// year — число ИЛИ массив чисел (мультивыбор). При нескольких годах данные
// суммируются. Возвращает primary-год (макс) для подписей + список выбранных.
async function computeBoard(year) {
  const years = (Array.isArray(year) ? year : [year]).map(y => parseInt(y, 10)).filter(Boolean);
  const yearsSel = years.length ? [...new Set(years)].sort((a, b) => a - b) : [new Date().getFullYear()];
  const primary = yearsSel[yearsSel.length - 1];
  const inSel = y => yearsSel.includes(y);

  const { rate, all } = await loadEnriched();
  const sold = all.filter(d => isSold(d.stage) && inSel(yr(d.contractDate)));
  const kp = all.filter(d => isKp(d.stage) && inSel(yr(d.createDate)));
  const pipe = all.filter(d => isPre(d.stage) && inSel(yr(d.createDate)));
  // Все продажи (любой год) в компактном виде — для клиентской фильтрации
  // вкладки «Компании» по году / отделу / менеджеру.
  const soldAll = all.filter(d => isSold(d.stage)).map(d => ({
    cId: d.companyId, co: d.company, ind: d.industry, y: yr(d.contractDate),
    dept: d.dept, mId: d.managerId, mgr: d.manager,
    cat: d.catGroup, manuf: d.manufacturer, instr: d.instrument, sum: d.sum,
  }));

  return {
    year: primary, yearsSel, rate,
    kpi: {
      soldSum: sum(sold), soldCount: sold.length, soldAvg: avg(sold),
      kpSum: sum(kp), kpCount: kp.length, kpAvg: avg(kp),
      companies: new Set(sold.map(d => d.companyId).filter(Boolean)).size,
      managers: new Set(sold.map(d => d.managerId).filter(Boolean)).size,
      pipeSum: sum(pipe), pipeCount: pipe.length,
    },
    funnel: snapshotFunnel(all, yearsSel),
    funnelDeals: snapshotDeals(all, yearsSel),
    producers: byManufacturer(sold),
    departments: [...new Set(sold.map(d => d.dept))].sort((a, b) => a.localeCompare(b, 'ru')),
    managers: byManager(sold),
    instrumentsSold: byInstrument(sold),
    instrumentsKp: byInstrument(kp),
    companies: byCompany(sold),
    companyDeals: soldAll,
    spheres: bySphere(sold),
    spheresPipe: bySpherePipe(pipe),
    years: [...new Set(all.map(d => yr(d.contractDate) || yr(d.createDate)).filter(Boolean))].sort((a, b) => b - a),
  };
}

const sum = arr => arr.reduce((s, d) => s + d.sum, 0);
const avg = arr => (arr.length ? sum(arr) / arr.length : 0);

// Воронка-снимок: сколько сделок/сумма СЕЙЧАС на каждом шаге (за выбранные годы
// по дате создания/контракта). years — массив выбранных лет.
function snapshotFunnel(all, years) {
  const inSel = y => years.includes(y);
  const steps = ['P10', 'P30', 'P60', 'P80', 'CONTRACT', 'EXEC', 'WON'];
  const labels = { P10: 'P10 · Новый лид', P30: 'P30 · Задача принята', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес', CONTRACT: 'Контракт', EXEC: 'Исполнение', WON: 'Завершена' };
  const inYear = all.filter(d => inSel(yr(d.createDate)) || inSel(yr(d.contractDate)));
  return steps.map(s => {
    const g = inYear.filter(d => d.step === s);
    return { step: s, label: labels[s], count: g.length, sum: sum(g) };
  });
}

// Лёгкий срез сделок для клиентской фильтрации воронки
// (по отделу / менеджеру / месяцу / производителю / прибору).
const moOf = d => { if (!d) return null; const n = parseInt(String(d).slice(5, 7), 10); return Number.isNaN(n) ? null : n; };
function snapshotDeals(all, years) {
  const inSel = y => years.includes(y);
  return all
    .filter(d => inSel(yr(d.createDate)) || inSel(yr(d.contractDate)))
    .map(d => ({
      step: d.step, dept: d.dept, managerId: d.managerId, manager: d.manager,
      manufacturer: d.manufacturer, instrument: d.instrument || '',
      sum: d.sum, month: moOf(d.createDate) || moOf(d.contractDate),
    }));
}

// Производители × направление (только продано)
function byManufacturer(deals) {
  const manufacturers = [...new Set(deals.map(d => d.manufacturer))].filter(m => m !== 'Не определено').sort();
  const groupSets = {};
  manufacturers.forEach(m => { const p = manufParent(m); (groupSets[p] = groupSets[p] || new Set()).add(m); });
  const parents = Object.keys(groupSets).sort();
  const groups = {}; parents.forEach(p => { groups[p] = [...groupSets[p]].sort(); });
  const typeOrder = ['Элементный', 'Хроматография и клеточный анализ', 'Электрохимия', 'Расходники', 'Сервис', 'Обучение', 'General Lab', 'Комплекс', 'Материаловедение'];
  const present = new Set(deals.map(d => d.dept));
  const types = typeOrder.filter(t => present.has(t));
  [...present].forEach(t => { if (!types.includes(t)) types.push(t); });
  const table = {};
  for (const t of types) { table[t] = { Common: 0 }; manufacturers.forEach(m => table[t][m] = 0); }
  for (const d of deals) {
    if (!table[d.dept]) continue;
    table[d.dept].Common += d.sum;
    if (d.manufacturer !== 'Не определено') table[d.dept][d.manufacturer] += d.sum;
  }
  return { manufacturers, parents, groups, types, table };
}

// Менеджеры (продано) — по алфавиту, с разрезами и списком сделок
function byManager(deals) {
  const by = {};
  for (const d of deals) {
    const k = d.managerId || 'unknown';
    if (!by[k]) by[k] = { managerId: d.managerId, name: d.manager, sum: 0, count: 0, byDept: {}, byManuf: {}, byCat: {}, byDeptC: {}, byManufC: {}, byCatC: {}, deals: [] };
    const m = by[k];
    m.sum += d.sum; m.count++;
    m.byDept[d.dept] = (m.byDept[d.dept] || 0) + d.sum; m.byDeptC[d.dept] = (m.byDeptC[d.dept] || 0) + 1;
    m.byManuf[d.manufacturer] = (m.byManuf[d.manufacturer] || 0) + d.sum; m.byManufC[d.manufacturer] = (m.byManufC[d.manufacturer] || 0) + 1;
    m.byCat[d.catGroup] = (m.byCat[d.catGroup] || 0) + d.sum; m.byCatC[d.catGroup] = (m.byCatC[d.catGroup] || 0) + 1;
    m.deals.push({ id: d.id, title: d.title, company: d.company, instrument: d.instrument, manufacturer: d.manufacturer, dept: d.dept, sum: d.sum, date: d.contractDate });
  }
  return Object.values(by).map(m => ({
    ...m, avg: m.count ? m.sum / m.count : 0,
    depts: [...new Set(m.deals.map(x => x.dept))],
    byDept: topEntries(m.byDept, m.byDeptC), byManuf: topEntries(m.byManuf, m.byManufC), byCat: topEntries(m.byCat, m.byCatC),
    deals: m.deals.sort((a, b) => b.sum - a.sum),
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Приборы — по группе (продано/КП): кол-во, сумма, чек, разрез по отделам и менеджерам
function byInstrument(deals) {
  const by = {};
  for (const d of deals) {
    if (!d.instrument) continue;
    const k = d.instrument;
    if (!by[k]) by[k] = { name: k, manufacturer: d.manufacturer, sum: 0, count: 0, byDept: {}, byManager: {}, byDeptC: {}, byManagerC: {} };
    const i = by[k];
    i.sum += d.sum; i.count++;
    i.byDept[d.dept] = (i.byDept[d.dept] || 0) + d.sum; i.byDeptC[d.dept] = (i.byDeptC[d.dept] || 0) + 1;
    i.byManager[d.manager] = (i.byManager[d.manager] || 0) + d.sum; i.byManagerC[d.manager] = (i.byManagerC[d.manager] || 0) + 1;
  }
  return Object.values(by).map(i => ({
    ...i, avg: i.count ? i.sum / i.count : 0,
    byDept: topEntries(i.byDept, i.byDeptC), byManager: topEntries(i.byManager, i.byManagerC),
  })).sort((a, b) => b.sum - a.sum);
}

// Компании — что купили (приборы/расходка/услуги/обучение), чек, топ-приборы, бренды
function byCompany(deals) {
  const by = {};
  for (const d of deals) {
    const k = d.companyId || d.company;
    if (!by[k]) by[k] = { companyId: d.companyId, name: d.company, industry: d.industry, sum: 0, count: 0, byCat: {}, byManuf: {}, instruments: {} };
    const c = by[k];
    c.sum += d.sum; c.count++;
    c.byCat[d.catGroup] = (c.byCat[d.catGroup] || 0) + d.sum;
    c.byManuf[d.manufacturer] = (c.byManuf[d.manufacturer] || 0) + d.sum;
    if (d.instrument) c.instruments[d.instrument] = (c.instruments[d.instrument] || 0) + d.sum;
    if (d.industry && d.industry !== 'Не указана') c.industry = d.industry;
  }
  const CAT_ORDER = ['Приборы', 'Расходники', 'Услуги', 'Обучение'];
  return Object.values(by).map(c => {
    const byCat = topEntries(c.byCat);
    const cats = CAT_ORDER.filter(k => c.byCat[k]); // какие категории покупали (в порядке)
    return {
      companyId: c.companyId, name: c.name, industry: c.industry, sum: c.sum, count: c.count,
      avg: c.count ? c.sum / c.count : 0,
      byCat, byManuf: topEntries(c.byManuf), topInstruments: topEntries(c.instruments).slice(0, 6),
      cats, complexity: cats.length, // «в комплексе» = сколько разных категорий брали
    };
  }).sort((a, b) => b.sum - a.sum);
}

// Сферы (подписанные / продано) — разрез по 4 воронкам (Приборы/Расходники/Сервис/Обучение),
// с суммой И количеством сделок в каждой воронке.
function bySphere(deals) {
  const by = {};
  for (const d of deals) {
    const k = d.industry;
    if (!by[k]) by[k] = { industry: k, sum: 0, count: 0, byCat: {}, byCatC: {}, companies: new Set() };
    const s = by[k];
    s.sum += d.sum; s.count++;
    s.byCat[d.funnel] = (s.byCat[d.funnel] || 0) + d.sum;
    s.byCatC[d.funnel] = (s.byCatC[d.funnel] || 0) + 1;
    if (d.companyId) s.companies.add(d.companyId);
  }
  return Object.values(by).map(s => ({
    industry: s.industry, sum: s.sum, count: s.count, avg: s.count ? s.sum / s.count : 0,
    companies: s.companies.size, byCat: topEntries(s.byCat, s.byCatC),
  })).sort((a, b) => b.sum - a.sum);
}

// Сферы (доконтрактные / в работе, P10–P80) — разрез по воронкам и по стадиям,
// сумма И количество сделок в каждой ячейке.
function bySpherePipe(deals) {
  const by = {};
  for (const d of deals) {
    const k = d.industry;
    if (!by[k]) by[k] = { industry: k, sum: 0, count: 0, byCat: {}, byCatC: {}, byStep: {}, byStepC: {}, companies: new Set() };
    const s = by[k];
    s.sum += d.sum; s.count++;
    s.byCat[d.funnel] = (s.byCat[d.funnel] || 0) + d.sum;
    s.byCatC[d.funnel] = (s.byCatC[d.funnel] || 0) + 1;
    s.byStep[d.step] = (s.byStep[d.step] || 0) + d.sum;
    s.byStepC[d.step] = (s.byStepC[d.step] || 0) + 1;
    if (d.companyId) s.companies.add(d.companyId);
  }
  return Object.values(by).map(s => ({
    industry: s.industry, sum: s.sum, count: s.count, avg: s.count ? s.sum / s.count : 0,
    companies: s.companies.size, byCat: topEntries(s.byCat, s.byCatC),
    byStep: PRE_ORDER.filter(st => s.byStep[st]).map(st => ({ key: st, label: PRE_LABELS[st], sum: s.byStep[st], count: s.byStepC[st] || 0 })),
  })).sort((a, b) => b.sum - a.sum);
}

function topEntries(obj, cnt) {
  return Object.entries(obj)
    .map(([k, v]) => ({ key: k, sum: v, count: cnt ? (cnt[k] || 0) : undefined }))
    .sort((a, b) => b.sum - a.sum);
}

// ── Фаза 2: реальные конверсии и тайминги по истории стадий ──────────────────
// Читает ticketsmodule_stage_history (моменты входа в стадии) + атрибуцию
// (менеджер/отдел/прибор) из зеркала сделок. Считает по когорте: сделки,
// чей ПЕРВЫЙ вход в воронку пришёлся на выбранный год.
const CONV_ORD = { P10: 0, P30: 1, P60: 2, P80: 3, CONTRACT: 4, EXEC: 4, WON: 5 };
const MS_DAY = 86400000;
const tms = v => { if (v == null) return NaN; if (v instanceof Date) return v.getTime(); const t = Date.parse(String(v)); return t; };

async function computeConversions(year) {
  const { rows: hist } = await pool.query('SELECT deal_id, stage_id, created_time FROM ticketsmodule_stage_history');
  if (!hist.length) return { year, hasData: false };

  // Атрибуция из зеркала (менеджер / отдел / прибор).
  const { rows: dealRows } = await pool.query(
    'SELECT deal_id, category_id, assigned_by_id, department_id, instrument_name FROM ticketsmodule_stat_deals'
  );
  const attr = {};
  for (const d of dealRows) {
    attr[d.deal_id] = {
      managerId: d.assigned_by_id, manager: uname(d.assigned_by_id),
      dept: direction(d.category_id, d.department_id),
      instrument: d.instrument_name || '—',
    };
  }

  // Группируем входы в стадии по сделке (только прогрессивные стадии; LOSE/FROZEN игнорим).
  const byDeal = {};
  const unmapped = {};
  for (const h of hist) {
    const st = step(h.stage_id);
    if (st == null) { const k = h.stage_id || '∅'; unmapped[k] = (unmapped[k] || 0) + 1; continue; }
    if (CONV_ORD[st] == null) continue;
    const t = tms(h.created_time);
    if (Number.isNaN(t)) continue;
    (byDeal[h.deal_id] = byDeal[h.deal_id] || []).push({ ord: CONV_ORD[st], t });
  }
  const diag = { histRows: hist.length, unmappedTop: Object.entries(unmapped).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k}:${n}`) };

  // По каждой сделке — момент первого достижения каждой вехи.
  const deals = [];
  for (const id in byDeal) {
    const entries = byDeal[id].sort((a, b) => a.t - b.t);
    const firstBeyond = o => { for (const e of entries) if (e.ord >= o) return e.t; return null; };
    const m = { P10: firstBeyond(0), P30: firstBeyond(1), P60: firstBeyond(2), P80: firstBeyond(3), CONTRACT: firstBeyond(4), WON: firstBeyond(5) };
    if (m.P10 == null) continue;
    if (new Date(m.P10).getFullYear() !== year) continue;
    deals.push({ id: Number(id), m, a: attr[id] || { manager: '—', dept: 'Не указан', instrument: '—', managerId: null } });
  }
  if (!deals.length) return { year, hasData: true, cohort: 0, funnel: [], headline: {}, timings: {}, byManager: [], byDept: [], byInstrument: [], diag };

  const reached = (arr, s) => arr.filter(d => d.m[s] != null).length;
  const avgDays = (arr, from, to) => {
    const v = arr.map(d => (d.m[to] != null && d.m[from] != null ? (d.m[to] - d.m[from]) / MS_DAY : null)).filter(x => x != null && x >= 0);
    return { avg: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length };
  };
  const rate = (a, b) => (b ? Math.round(a / b * 1000) / 10 : 0);

  const c = {
    P10: reached(deals, 'P10'), P30: reached(deals, 'P30'), P60: reached(deals, 'P60'),
    P80: reached(deals, 'P80'), CONTRACT: reached(deals, 'CONTRACT'), WON: reached(deals, 'WON'),
  };
  const FL = { P10: 'P10 · Новый лид', P30: 'P30 · Задача принята', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес', CONTRACT: 'Контракт', WON: 'Завершена' };
  const order = ['P10', 'P30', 'P60', 'P80', 'CONTRACT', 'WON'];
  const funnel = order.map((s, i) => ({
    step: s, label: FL[s], count: c[s],
    fromStart: rate(c[s], c.P10),
    fromPrev: i === 0 ? 100 : rate(c[s], c[order[i - 1]]),
  }));

  const headline = {
    leadToKp: { rate: rate(c.P60, c.P10), a: c.P60, b: c.P10 },
    kpToContract: { rate: rate(c.CONTRACT, c.P60), a: c.CONTRACT, b: c.P60 },
    leadToContract: { rate: rate(c.CONTRACT, c.P10), a: c.CONTRACT, b: c.P10 },
    contractToWon: { rate: rate(c.WON, c.CONTRACT), a: c.WON, b: c.CONTRACT },
  };
  const timings = {
    p10p30: avgDays(deals, 'P10', 'P30'),
    p30p60: avgDays(deals, 'P30', 'P60'),
    p60p80: avgDays(deals, 'P60', 'P80'),
    p80contract: avgDays(deals, 'P80', 'CONTRACT'),
    leadToKp: avgDays(deals, 'P10', 'P60'),
    kpToContract: avgDays(deals, 'P60', 'CONTRACT'),
    leadToContract: avgDays(deals, 'P10', 'CONTRACT'),
    contractToWon: avgDays(deals, 'CONTRACT', 'WON'),
  };

  const groupStat = keyFn => {
    const g = {};
    for (const d of deals) { const k = keyFn(d); if (k == null || k === '') continue; (g[k] = g[k] || []).push(d); }
    return Object.values(g).map(arr => {
      const con = reached(arr, 'CONTRACT');
      const kp = reached(arr, 'P60');
      return {
        key: keyFn(arr[0]), cohort: arr.length, kp, contract: con,
        convRate: rate(con, arr.length),
        avgCycle: avgDays(arr, 'P10', 'CONTRACT').avg,
        avgToKp: avgDays(arr, 'P10', 'P60').avg,
      };
    }).sort((a, b) => b.cohort - a.cohort);
  };

  return {
    year, hasData: true, cohort: deals.length,
    funnel, headline, timings,
    byManager: groupStat(d => d.a.manager),
    byDept: groupStat(d => d.a.dept),
    byInstrument: groupStat(d => d.a.instrument).slice(0, 40),
    diag,
  };
}

module.exports = {
  computeBoard, computeConversions,
  // для выгрузки по сферам (stats-export.js)
  loadEnriched, isSold, isPre, step, yr, funnelName,
  FUNNEL_ORDER, PRE_ORDER, PRE_LABELS,
};

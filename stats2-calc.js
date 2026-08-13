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
const SOLD_STEPS = new Set(['CONTRACT', 'EXEC', 'WON']); // «Продано» = контракт и далее до завершения
const KP_STEPS = new Set(['P60', 'P80']);                // «Выдано КП»
const isSold = s => SOLD_STEPS.has(step(s));
const isKp = s => KP_STEPS.has(step(s));

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
// «Направление» для таблицы: приборы (воронка 0) — по полю «Отдел», а расходка/
// обучение/сервис — это САМИ воронки (1/2/3), считаем их целиком по воронке,
// а не по полю «Отдел» (которое у них часто пустое → сервис недосчитывался).
const CAT_DIRECTION = { 1: 'Расходники', 2: 'Обучение', 3: 'Сервис' };
const direction = (catId, departmentId) => CAT_DIRECTION[catId] || deptLabel(departmentId);

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

// ── Основной расчёт борда за год ─────────────────────────────────────────────
async function computeBoard(year) {
  const rate = await getTodayRate();
  const kzt = d => (d.currency_id === 'USD' ? (parseFloat(d.opportunity) || 0) * rate : (parseFloat(d.opportunity) || 0));

  const { rows } = await pool.query('SELECT * FROM ticketsmodule_stat_deals');
  const indMap = await getIndustryMap();

  // Обогащаем и делим на группы
  const enrich = d => ({
    id: d.deal_id, cat: d.category_id, stage: d.stage_id, step: step(d.stage_id),
    sum: kzt(d), dept: direction(d.category_id, d.department_id), catGroup: CAT_GROUP[d.category_id] || '—',
    managerId: d.assigned_by_id, manager: uname(d.assigned_by_id),
    manufacturer: d.manufacturer && d.manufacturer !== 'Не определено' ? d.manufacturer : 'Не определено',
    instrument: d.instrument_name || '', title: d.deal_title || '',
    companyId: d.company_id, company: d.company_name || (d.company_id ? `Компания #${d.company_id}` : 'Без компании'),
    industry: (d.industry != null && d.industry !== '' ? (indMap[String(d.industry)] || String(d.industry)) : 'Не указана'),
    contractDate: ymd(d.contract_date),
    createDate: ymd(d.date_create),
  });

  const all = rows.map(enrich);
  const sold = all.filter(d => isSold(d.stage) && yr(d.contractDate) === year);
  const kp = all.filter(d => isKp(d.stage) && yr(d.createDate) === year);

  return {
    year, rate,
    kpi: {
      soldSum: sum(sold), soldCount: sold.length, soldAvg: avg(sold),
      kpSum: sum(kp), kpCount: kp.length, kpAvg: avg(kp),
      companies: new Set(sold.map(d => d.companyId).filter(Boolean)).size,
      managers: new Set(sold.map(d => d.managerId).filter(Boolean)).size,
    },
    funnel: snapshotFunnel(all, year),
    funnelDeals: snapshotDeals(all, year),
    producers: byManufacturer(sold),
    departments: [...new Set(sold.map(d => d.dept))].sort((a, b) => a.localeCompare(b, 'ru')),
    managers: byManager(sold),
    instrumentsSold: byInstrument(sold),
    instrumentsKp: byInstrument(kp),
    companies: byCompany(sold),
    spheres: bySphere(sold),
    years: [...new Set(all.map(d => yr(d.contractDate)).filter(Boolean))].sort((a, b) => b - a),
  };
}

const sum = arr => arr.reduce((s, d) => s + d.sum, 0);
const avg = arr => (arr.length ? sum(arr) / arr.length : 0);

// Воронка-снимок: сколько сделок/сумма СЕЙЧАС на каждом шаге (за год по дате создания)
function snapshotFunnel(all, year) {
  const steps = ['P10', 'P30', 'P60', 'P80', 'CONTRACT', 'EXEC', 'WON'];
  const labels = { P10: 'P10 · Новый лид', P30: 'P30 · Задача принята', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес', CONTRACT: 'Контракт', EXEC: 'Исполнение', WON: 'Завершена' };
  const inYear = all.filter(d => yr(d.createDate) === year || yr(d.contractDate) === year);
  return steps.map(s => {
    const g = inYear.filter(d => d.step === s);
    return { step: s, label: labels[s], count: g.length, sum: sum(g) };
  });
}

// Лёгкий срез сделок для клиентской фильтрации воронки
// (по отделу / менеджеру / месяцу / производителю / прибору).
const moOf = d => { if (!d) return null; const n = parseInt(String(d).slice(5, 7), 10); return Number.isNaN(n) ? null : n; };
function snapshotDeals(all, year) {
  return all
    .filter(d => yr(d.createDate) === year || yr(d.contractDate) === year)
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
    if (!by[k]) by[k] = { managerId: d.managerId, name: d.manager, sum: 0, count: 0, byDept: {}, byManuf: {}, byCat: {}, deals: [] };
    const m = by[k];
    m.sum += d.sum; m.count++;
    m.byDept[d.dept] = (m.byDept[d.dept] || 0) + d.sum;
    m.byManuf[d.manufacturer] = (m.byManuf[d.manufacturer] || 0) + d.sum;
    m.byCat[d.catGroup] = (m.byCat[d.catGroup] || 0) + d.sum;
    m.deals.push({ id: d.id, title: d.title, company: d.company, instrument: d.instrument, manufacturer: d.manufacturer, dept: d.dept, sum: d.sum, date: d.contractDate });
  }
  return Object.values(by).map(m => ({
    ...m, avg: m.count ? m.sum / m.count : 0,
    depts: [...new Set(m.deals.map(x => x.dept))],
    byDept: topEntries(m.byDept), byManuf: topEntries(m.byManuf), byCat: topEntries(m.byCat),
    deals: m.deals.sort((a, b) => b.sum - a.sum),
  })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Приборы — по группе (продано/КП): кол-во, сумма, чек, разрез по отделам и менеджерам
function byInstrument(deals) {
  const by = {};
  for (const d of deals) {
    if (!d.instrument) continue;
    const k = d.instrument;
    if (!by[k]) by[k] = { name: k, manufacturer: d.manufacturer, sum: 0, count: 0, byDept: {}, byManager: {} };
    const i = by[k];
    i.sum += d.sum; i.count++;
    i.byDept[d.dept] = (i.byDept[d.dept] || 0) + d.sum;
    i.byManager[d.manager] = (i.byManager[d.manager] || 0) + d.sum;
  }
  return Object.values(by).map(i => ({
    ...i, avg: i.count ? i.sum / i.count : 0,
    byDept: topEntries(i.byDept), byManager: topEntries(i.byManager),
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

// Сферы деятельности — то же по industry
function bySphere(deals) {
  const by = {};
  for (const d of deals) {
    const k = d.industry;
    if (!by[k]) by[k] = { industry: k, sum: 0, count: 0, byCat: {}, companies: new Set() };
    const s = by[k];
    s.sum += d.sum; s.count++;
    s.byCat[d.catGroup] = (s.byCat[d.catGroup] || 0) + d.sum;
    if (d.companyId) s.companies.add(d.companyId);
  }
  return Object.values(by).map(s => ({
    industry: s.industry, sum: s.sum, count: s.count, avg: s.count ? s.sum / s.count : 0,
    companies: s.companies.size, byCat: topEntries(s.byCat),
  })).sort((a, b) => b.sum - a.sum);
}

function topEntries(obj) {
  return Object.entries(obj).map(([k, v]) => ({ key: k, sum: v })).sort((a, b) => b.sum - a.sum);
}

module.exports = { computeBoard };

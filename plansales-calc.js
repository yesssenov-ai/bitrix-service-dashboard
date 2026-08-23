// Расчётный слой модуля «План продаж».
// Читает доконтрактные сделки (P10–P80) из зеркала ticketsmodule_stat_deals и
// раскладывает их по МЕСЯЦАМ «Планируемого срока покупки» (UF_CRM_1731862888595).
// Сделки БЕЗ планируемой даты в план не попадают (по договорённости — скрываем).
// Фронт сам фильтрует по стадиям/отделу/менеджеру/флагу и строит сводку и
// pipeline текущего/следующего месяца — сюда отдаём обогащённый список сделок.
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');

// ── Стадии воронок (все 4 воронки), как в stats2-calc ─────────────────────────
const RAW = {
  P10: ['NEW', 'C1:NEW', 'C2:NEW', 'C3:NEW'],
  P30: ['PREPARATION', 'C1:PREPARATION', 'C2:PREPARATION', 'C3:PREPARATION'],
  P60: ['PREPAYMENT_INVOICE', 'C1:PREPAYMENT_INVOICE', 'C2:PREPAYMENT_INVOICE', 'C3:PREPAYMENT_INVOICE'],
  P80: ['EXECUTING', 'C1:EXECUTING', 'C2:EXECUTING', 'C3:EXECUTING'],
};
const STAGE_STEP = {};
for (const [st, ids] of Object.entries(RAW)) ids.forEach(id => { STAGE_STEP[id] = st; });
const stepOf = s => STAGE_STEP[s] || null;             // null = не доконтрактная (в план не берём)
// «Подписано» — законтрактованные сделки (от стадии договора до завершения), ровно
// как в модуле «Контракты» (CONTRACT_SET, включая WON). Раскладываем по месяцам
// по ДАТЕ ДОГОВОРА (contract_date) — так «Контракты авг = 284» бьётся с блоком.
const CONTRACT_STAGES = {
  0: ['FINAL_INVOICE', '1', 'UC_Q9J6VV', 'UC_9MBFR2', '2', '3', 'WON'],
  1: ['C1:FINAL_INVOICE', 'C1:1', 'C1:UC_3MVK90', 'C1:UC_3SCB5K', 'C1:2', 'C1:3', 'C1:WON'],
  2: ['C2:FINAL_INVOICE', 'C2:1', 'C2:2', 'C2:WON'],
  3: ['C3:FINAL_INVOICE', 'C3:UC_YYTFYG', 'C3:2', 'C3:WON'],
};
const CONTRACT_SET = Object.values(CONTRACT_STAGES).flat();
const STEP_LABELS = { P10: 'P10 · Новый лид', P30: 'P30 · Задача принята', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес' };

// ── Направление (Отдел) — поле «Отдел», иначе короткое имя воронки ─────────────
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'ОРМ', '4863': 'Сервис',
  '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const deptLabel = id => {
  const l = DEPARTMENT_LABELS[id] || id || 'Не указан';
  return (l === 'Хроматография' || l === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : l;
};
// Если поле «Отдел» у сделки пустое — падаем на смысл воронки. Воронки 1/2/3 сами
// по себе = отдел (ОРМ / Тренинг-центр / Сервис). А воронка 0 (Приборы) — общая для
// пяти отделов (Хроматография, Элементный, Электрохимия, General Lab, Материаловедение),
// поэтому без заполненного «Отдела» её нельзя отнести → «Отдел не указан» (надо
// проставить отдел в сделке Bitrix, чтобы она встала в свой отдел).
const PIPE_FALLBACK = { 0: 'Отдел не указан', 1: 'ОРМ', 2: 'Тренинг-центр', 3: 'Сервис' };

// Привязка МЕНЕДЖЕР → ОТДЕЛ. Используется ТОЛЬКО когда у сделки не заполнено поле
// «Отдел» в воронке «Приборы» (category 0) — тогда относим сделку к отделу по её
// менеджеру. (Категории 1/2/3 уже сами = отдел ОРМ/Тренинг-центр/Сервис.)
// Сопоставление по ИМЕНИ менеджера (из Bitrix), устойчивое к порядку слов и к
// казахскому написанию (Бақытжан→Бакытжан и т.п.).
const MANAGER_DEPT_LIST = [
  ['Данияр Орахбаев', 'Хроматография и клеточный анализ'],
  ['Гаухар Ахметжан', 'Хроматография и клеточный анализ'],
  ['Дамели Садырова', 'Хроматография и клеточный анализ'],
  ['Руслан Касен', 'Элементный'],
  ['Айжан Байжигитова', 'Элементный'],
  ['Шокан Рымбек', 'Элементный'],
  ['Бакытжан Шаймурат', 'Элементный'],
  ['Аманжол Сыздыков', 'Элементный'],
  ['Мурат Булегенов', 'Электрохимия'],
  ['Аруна Болатова', 'General Lab'],
  ['Рабига Нуржанова', 'General Lab'],
  ['Акгулим Самиголлаева', 'General Lab'],
  ['Бахытгуль Даут', 'General Lab'],
  ['Жадыра Сагитова', 'General Lab'],
  ['Айнур Орынбаева', 'General Lab'],
  ['Максим Мазняк', 'Материаловедение'],
  ['Айнур Карпсеитова', 'Комплекс'],
  ['Алмат Ляшев', 'Комплекс'],
  ['Асылбек Ожикен', 'Robots'],
];
// Нормализация имени: нижний регистр, казахские буквы → русские, только буквы,
// слова сортируются (чтобы «Айжан Байжигитова» = «Байжигитова Айжан»).
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/қ/g, 'к').replace(/[ұү]/g, 'у').replace(/ә/g, 'а').replace(/ө/g, 'о')
    .replace(/ғ/g, 'г').replace(/і/g, 'и').replace(/ң/g, 'н').replace(/һ/g, 'х').replace(/ё/g, 'е')
    .replace(/[^a-zа-я\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function nameKey(s) { return normName(s).split(' ').filter(Boolean).sort().join(' '); }
const MANAGER_DEPT = {};
for (const [nm, dep] of MANAGER_DEPT_LIST) MANAGER_DEPT[nameKey(nm)] = dep;

// Менеджеры, которые в «Приборах» ведут ДВА отдела — разводим по производителю.
// Назерке Марат / Асем Жарылгап / Айнель Сеитова: Metrohm → Электрохимия, иначе General Lab.
const MANAGER_SPLIT = {};
[['Назерке Марат'], ['Асем Жарылгап'], ['Айнель Сеитова']].forEach(([nm]) => {
  MANAGER_SPLIT[nameKey(nm)] = manuf => (/metrohm/i.test(manuf || '') ? 'Электрохимия' : 'General Lab');
});

const direction = (catId, departmentId, managerId, manufacturer) => {
  if (departmentId && DEPARTMENT_LABELS[departmentId]) return deptLabel(departmentId);
  // Пустой «Отдел» в воронке «Приборы» — определяем по менеджеру.
  if (catId === 0 || catId === '0') {
    const key = nameKey(uname(managerId));
    if (MANAGER_SPLIT[key]) return MANAGER_SPLIT[key](manufacturer);
    if (MANAGER_DEPT[key]) return MANAGER_DEPT[key];
  }
  return PIPE_FALLBACK[catId] || 'Не указан';
};
const DEPT_ORDER = ['Элементный', 'Хроматография и клеточный анализ', 'Электрохимия', 'ОРМ', 'Сервис', 'General Lab', 'Тренинг-центр', 'Комплекс', 'Материаловедение', 'Robots', 'Отдел не указан'];

const uname = id => id ? (USERS[id] || `#${id}`) : '—';
const ymd = v => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
function dealUrlBase() {
  try { return new URL(process.env.BITRIX_WEBHOOK).origin + '/crm/deal/details/'; }
  catch (e) { return null; }
}

// Обогащённый список доконтрактных сделок с планируемой датой.
async function getPlanSales() {
  const rate = await getTodayRate();               // USD→KZT (как в Статистике/Контрактах)
  const base = dealUrlBase();
  const { rows } = await pool.query(
    `SELECT deal_id, category_id, stage_id, opportunity, currency_id, assigned_by_id,
            department_id, deal_title, company_name,
            TO_CHAR(planned_purchase_date,'YYYY-MM-DD') AS planned_purchase_date,
            likely_deal, manufacturer
       FROM ticketsmodule_stat_deals
      WHERE planned_purchase_date IS NOT NULL`
  );
  // Дата последней смены стадии (из истории стадий) — чтобы подсветить «зависшие»
  // сделки, которые стоят на одной стадии дольше 3 месяцев (не двигаются).
  const lastMoved = {};
  try {
    const { rows: hm } = await pool.query('SELECT deal_id, MAX(created_time) AS t FROM ticketsmodule_stage_history GROUP BY deal_id');
    hm.forEach(h => { if (h.t) lastMoved[h.deal_id] = new Date(h.t).getTime(); });
  } catch (e) { /* best-effort: без истории просто не подсветим */ }
  const NOWMS = Date.now();
  const STUCK_DAYS = 90;
  const deals = [];
  const yearsSet = new Set(), deptSet = new Set(), mgrMap = new Map();
  for (const r of rows) {
    const step = stepOf(r.stage_id);
    if (!step) continue;                            // только P10–P80
    const planned = ymd(r.planned_purchase_date);
    if (!planned) continue;
    const y = parseInt(planned.slice(0, 4), 10);
    const monthIdx = parseInt(planned.slice(5, 7), 10) - 1;
    if (!(monthIdx >= 0 && monthIdx <= 11)) continue;
    const raw = parseFloat(r.opportunity) || 0;
    const sum = r.currency_id === 'USD' ? raw * rate : raw;
    const managerId = r.assigned_by_id || null;
    const managerName = uname(managerId);
    const dept = direction(r.category_id, r.department_id, managerId, r.manufacturer);
    yearsSet.add(y); deptSet.add(dept);
    if (managerId) mgrMap.set(managerId, managerName);
    const lm = lastMoved[r.deal_id] || null;
    const stuckDays = lm ? Math.floor((NOWMS - lm) / 86400000) : null;
    deals.push({
      id: r.deal_id,
      title: r.deal_title || ('Сделка #' + r.deal_id),
      company: r.company_name || '',
      dept, managerId, managerName,
      sum, rawSum: raw, currency: r.currency_id || 'KZT',
      step, stageLabel: STEP_LABELS[step] || step,
      planned, year: y, monthIdx,
      likely: !!r.likely_deal,
      stuckDays, stuck: stuckDays != null && stuckDays >= STUCK_DAYS,
      lastMoved: lm ? new Date(lm).toISOString().slice(0, 10) : null,
      url: base ? (base + r.deal_id + '/') : null,
    });
  }
  const years = [...yearsSet].sort((a, b) => a - b);
  const depts = [...deptSet].sort((a, b) => {
    const ia = DEPT_ORDER.indexOf(a), ib = DEPT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const managers = [...mgrMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  // Кто «не распределён по отделам» — менеджеры сделок, оставшихся «Отдел не указан»
  // (нужно, чтобы назначить отдел по менеджеру). С количеством сделок.
  const unMap = new Map();
  for (const d of deals) {
    if (d.dept !== 'Отдел не указан') continue;
    const k = d.managerId || 0;
    const e = unMap.get(k) || { id: d.managerId || null, name: d.managerName, count: 0, sum: 0 };
    e.count++; e.sum += d.sum; unMap.set(k, e);
  }
  const unassigned = [...unMap.values()].sort((a, b) => b.count - a.count);

  // «Подписано» по месяцам (по дате договора), как в модуле «Контракты». Тянем
  // текущий и следующий год; фронт берёт нужный месяц. Фильтр Отдел/Менеджер — на фронте.
  const yrNow = new Date().getFullYear();
  let signed = [];
  try {
    const { rows: sr } = await pool.query(
      `SELECT category_id, department_id, assigned_by_id, opportunity, currency_id, manufacturer,
              TO_CHAR(contract_date,'YYYY-MM-DD') AS cd
         FROM ticketsmodule_stat_deals
        WHERE contract_date BETWEEN $1 AND $2 AND stage_id = ANY($3)`,
      [`${yrNow}-01-01`, `${yrNow + 1}-12-31`, CONTRACT_SET]
    );
    signed = sr.map(r => {
      const raw = parseFloat(r.opportunity) || 0;
      const sm = r.currency_id === 'USD' ? raw * rate : raw;
      return {
        dept: direction(r.category_id, r.department_id, r.assigned_by_id || null, r.manufacturer),
        managerId: r.assigned_by_id || null,
        y: +r.cd.slice(0, 4), monthIdx: +r.cd.slice(5, 7) - 1, sum: sm,
      };
    });
  } catch (e) { /* best-effort */ }

  // Время последнего обновления зеркала
  let updatedAt = null;
  try { const { rows: u } = await pool.query('SELECT MAX(synced_at) AS m FROM ticketsmodule_stat_deals'); updatedAt = u[0] && u[0].m; } catch (e) { /* ignore */ }
  return { deals, meta: { years, depts, managers, unassigned, signed, rate, updatedAt, stepLabels: STEP_LABELS, deptOrder: DEPT_ORDER } };
}

module.exports = { getPlanSales, DEPT_ORDER };

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
const STEP_LABELS = { P10: 'P10 · Новый лид', P30: 'P30 · Задача принята', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес' };

// ── Направление (Отдел) — поле «Отдел», иначе короткое имя воронки ─────────────
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'ОРМ', '4863': 'Сервис',
  '4864': 'Обучение', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const deptLabel = id => {
  const l = DEPARTMENT_LABELS[id] || id || 'Не указан';
  return (l === 'Хроматография' || l === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : l;
};
const PIPE_FALLBACK = { 0: 'Инструменты', 1: 'ОРМ', 2: 'Обучение', 3: 'Сервис' };
const direction = (catId, departmentId) => {
  if (departmentId && DEPARTMENT_LABELS[departmentId]) return deptLabel(departmentId);
  return PIPE_FALLBACK[catId] || 'Не указан';
};
const DEPT_ORDER = ['Элементный', 'Хроматография и клеточный анализ', 'Электрохимия', 'ОРМ', 'Сервис', 'General Lab', 'Обучение', 'Комплекс', 'Материаловедение', 'Инструменты'];

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
            department_id, deal_title, company_name, planned_purchase_date, likely_deal
       FROM ticketsmodule_stat_deals
      WHERE planned_purchase_date IS NOT NULL`
  );
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
    const dept = direction(r.category_id, r.department_id);
    const managerId = r.assigned_by_id || null;
    const managerName = uname(managerId);
    yearsSet.add(y); deptSet.add(dept);
    if (managerId) mgrMap.set(managerId, managerName);
    deals.push({
      id: r.deal_id,
      title: r.deal_title || ('Сделка #' + r.deal_id),
      company: r.company_name || '',
      dept, managerId, managerName,
      sum, rawSum: raw, currency: r.currency_id || 'KZT',
      step, stageLabel: STEP_LABELS[step] || step,
      planned, year: y, monthIdx,
      likely: !!r.likely_deal,
      url: base ? (base + r.deal_id + '/') : null,
    });
  }
  const years = [...yearsSet].sort((a, b) => a - b);
  const depts = [...deptSet].sort((a, b) => {
    const ia = DEPT_ORDER.indexOf(a), ib = DEPT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const managers = [...mgrMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  // Время последнего обновления зеркала
  let updatedAt = null;
  try { const { rows: u } = await pool.query('SELECT MAX(synced_at) AS m FROM ticketsmodule_stat_deals'); updatedAt = u[0] && u[0].m; } catch (e) { /* ignore */ }
  return { deals, meta: { years, depts, managers, rate, updatedAt, stepLabels: STEP_LABELS, deptOrder: DEPT_ORDER } };
}

module.exports = { getPlanSales, DEPT_ORDER };

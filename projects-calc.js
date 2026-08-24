// Расчётный слой модуля «Проекты» (комплексные сделки / БДМ).
// Новая модель: Группа компаний → Клиент (компания) → БДМ → Проект (комплексная
// сделка, Тип КП/Договора=Complex) → продакт-сделки (дочерние, привязанные полем
// «Родительская сделка (Complex)»). Единичные сделки без родителя катятся к клиенту,
// у клиента — свой БДМ (справочник ЦУП). Плюс аудит нарушений новой модели.
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');
const { EMPLOYEE_DEPT } = require('./dept-map');

const uname = id => id ? (USERS[id] || ('#' + id)) : '—';

// Стадии → шаг воронки (доконтракт P10–P80), как в «Плане продаж».
const RAW = {
  P10: ['NEW', 'C1:NEW', 'C2:NEW', 'C3:NEW'],
  P30: ['PREPARATION', 'C1:PREPARATION', 'C2:PREPARATION', 'C3:PREPARATION'],
  P60: ['PREPAYMENT_INVOICE', 'C1:PREPAYMENT_INVOICE', 'C2:PREPAYMENT_INVOICE', 'C3:PREPAYMENT_INVOICE'],
  P80: ['EXECUTING', 'C1:EXECUTING', 'C2:EXECUTING', 'C3:EXECUTING'],
};
const STAGE_STEP = {};
for (const [st, ids] of Object.entries(RAW)) ids.forEach(id => { STAGE_STEP[id] = st; });
const CONTRACT_SET = new Set([
  'FINAL_INVOICE', '1', 'UC_Q9J6VV', 'UC_9MBFR2', '2', '3', 'WON',
  'C1:FINAL_INVOICE', 'C1:1', 'C1:UC_3MVK90', 'C1:UC_3SCB5K', 'C1:2', 'C1:3', 'C1:WON',
  'C2:FINAL_INVOICE', 'C2:1', 'C2:2', 'C2:WON',
  'C3:FINAL_INVOICE', 'C3:UC_YYTFYG', 'C3:2', 'C3:WON',
]);
function stageInfo(stageId) {
  const step = STAGE_STEP[stageId] || null;
  if (step) return { step, kind: 'pipeline' };
  if (CONTRACT_SET.has(stageId)) return { step: 'CONTRACT', kind: 'contract' };
  if (/LOSE|LOSER|APOLOGY|:FAIL/i.test(stageId || '')) return { step: 'LOST', kind: 'lost' };
  return { step: stageId || '—', kind: 'other' };
}
const STEP_ORDER = { P10: 1, P30: 2, P60: 3, P80: 4, CONTRACT: 5 };

const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия', '4860': 'Клеточный анализ',
  '4862': 'ОРМ', '4863': 'Сервис', '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const PIPE_FALLBACK = { 0: 'Приборы', 1: 'ОРМ', 2: 'Тренинг-центр', 3: 'Сервис' };
function productOf(d) {
  if (d.department_id && DEPARTMENT_LABELS[d.department_id]) {
    const l = DEPARTMENT_LABELS[d.department_id];
    return (l === 'Хроматография' || l === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : l;
  }
  return PIPE_FALLBACK[d.category_id] || 'Не указан';
}

function dealBaseUrl() {
  try { return new URL(process.env.BITRIX_WEBHOOK).origin + '/crm/deal/details/'; } catch (e) { return null; }
}

async function getProjects() {
  const rate = await getTodayRate();
  const base = dealBaseUrl();
  const { rows } = await pool.query(
    `SELECT deal_id, company_id, company_name, assigned_by_id, stage_id, category_id,
            opportunity, currency_id, kp_type, is_complex, parent_deal_id, group_ref,
            department_id, instrument_name, end_user
       FROM ticketsmodule_stat_deals`
  );
  // Справочник Клиент→БДМ→Группа (ЦУП).
  const dir = new Map();
  try {
    const { rows: dc } = await pool.query('SELECT company_id, bdm_bitrix_id, group_name FROM ticketsmodule_project_clients');
    dc.forEach(r => dir.set(String(r.company_id), { bdm: r.bdm_bitrix_id || null, group: r.group_name || null }));
  } catch (e) { /* best-effort */ }

  const sumOf = d => (d.currency_id === 'USD' ? (parseFloat(d.opportunity) || 0) * rate : (parseFloat(d.opportunity) || 0));
  const url = id => base ? (base + id + '/') : null;

  // Индексация
  const byId = new Map();
  const childrenByParent = new Map();
  const parents = [];
  for (const d of rows) {
    d._sum = sumOf(d);
    d._st = stageInfo(d.stage_id);
    d._product = productOf(d);
    byId.set(Number(d.deal_id), d);
    if (d.kp_type === 'Complex') parents.push(d);
    if (d.parent_deal_id) {
      const k = Number(d.parent_deal_id);
      if (!childrenByParent.has(k)) childrenByParent.set(k, []);
      childrenByParent.get(k).push(d);
    }
  }

  const dealCard = d => ({
    dealId: Number(d.deal_id), title: d.deal_title || d.company_name || ('Сделка #' + d.deal_id),
    company: d.company_name || '', product: d._product, step: d._st.step, kind: d._st.kind,
    stage: d.stage_id, sum: d._sum, ownerId: d.assigned_by_id || null, owner: uname(d.assigned_by_id),
    isComplex: !!d.is_complex, endUser: d.end_user || null, url: url(d.deal_id),
  });

  // Клиенты: группируем все сделки по компании
  const byCompany = new Map();
  for (const d of rows) {
    const cid = d.company_id ? String(d.company_id) : ('name:' + (d.company_name || '—'));
    if (!byCompany.has(cid)) byCompany.set(cid, { companyId: d.company_id || null, company: d.company_name || '—', deals: [] });
    byCompany.get(cid).deals.push(d);
  }

  const clients = [];
  for (const [cid, c] of byCompany) {
    const info = dir.get(String(c.companyId));
    // БДМ клиента: из справочника ЦУП, иначе — владелец любой комплексной сделки клиента.
    let bdmId = info && info.bdm ? info.bdm : null, bdmSource = bdmId ? 'справочник' : null;
    const complexOfClient = c.deals.filter(d => d.kp_type === 'Complex');
    if (!bdmId && complexOfClient.length) { bdmId = complexOfClient[0].assigned_by_id || null; bdmSource = bdmId ? 'комплексная сделка' : null; }
    const group = (info && info.group) || null;

    // Проекты (комплексные сделки клиента) + их дети
    const projects = complexOfClient.map(p => {
      const kids = (childrenByParent.get(Number(p.deal_id)) || []).map(dealCard).sort((a, b) => b.sum - a.sum);
      const childSum = kids.reduce((s, k) => s + k.sum, 0);
      return { ...dealCard(p), children: kids, childSum, totalSum: p._sum + childSum, bdmId: p.assigned_by_id || null, bdm: uname(p.assigned_by_id) };
    }).sort((a, b) => b.totalSum - a.totalSum);

    // Единичные сделки: не комплексные-родители и без родителя
    const linkedChildIds = new Set(projects.flatMap(p => p.children.map(k => k.dealId)));
    const standalone = c.deals
      .filter(d => d.kp_type !== 'Complex' && !d.parent_deal_id && !linkedChildIds.has(Number(d.deal_id)))
      .map(dealCard).sort((a, b) => b.sum - a.sum);

    const totalSum = projects.reduce((s, p) => s + p.totalSum, 0) + standalone.reduce((s, d) => s + d.sum, 0);
    clients.push({
      companyId: c.companyId, company: c.company, group,
      bdmId, bdm: bdmId ? uname(bdmId) : null, bdmSource,
      projects, standalone,
      dealCount: c.deals.length, totalSum,
    });
  }
  clients.sort((a, b) => b.totalSum - a.totalSum);

  // Группировка по Группе компаний
  const groupsMap = new Map();
  for (const cl of clients) {
    const g = cl.group || 'Без группы';
    if (!groupsMap.has(g)) groupsMap.set(g, []);
    groupsMap.get(g).push(cl);
  }
  const groupsTree = [...groupsMap.entries()].map(([group, cls]) => ({
    group, clients: cls, totalSum: cls.reduce((s, c) => s + c.totalSum, 0), clientCount: cls.length,
  })).sort((a, b) => b.totalSum - a.totalSum);

  // ── Аудит новой модели ────────────────────────────────────────────────────
  const noBdm = clients.filter(c => !c.bdmId && c.totalSum > 0)
    .map(c => ({ companyId: c.companyId, company: c.company, group: c.group, dealCount: c.dealCount, totalSum: c.totalSum }));

  // P60+ сделка, не комплексная и без родителя (по новой модели должна быть привязана)
  const orphanP60 = rows
    .filter(d => (d._st.step === 'P60' || d._st.step === 'P80') && d.kp_type !== 'Complex' && !d.parent_deal_id && !d.is_complex)
    .map(dealCard).sort((a, b) => b.sum - a.sum);

  // Один клиент + один продукт → разные менеджеры (то, что убираем)
  const multiManager = [];
  for (const cl of clients) {
    const prodMgr = new Map();
    cl.projects.forEach(p => p.children.forEach(k => addPM(prodMgr, k)));
    cl.standalone.forEach(k => addPM(prodMgr, k));
    for (const [product, mgrs] of prodMgr) {
      if (mgrs.size > 1) multiManager.push({ companyId: cl.companyId, company: cl.company, product, managers: [...mgrs.values()] });
    }
  }
  function addPM(map, k) {
    if (!k.ownerId) return;
    if (!map.has(k.product)) map.set(k.product, new Map());
    map.get(k.product).set(k.ownerId, k.owner);
  }

  // Кандидаты в БДМ + список групп (для справочника на фронте)
  const employees = Object.keys(EMPLOYEE_DEPT).map(id => ({ id: Number(id), name: uname(id), dept: EMPLOYEE_DEPT[id] }))
    .filter(e => e.name && e.name !== ('#' + e.id)).sort((a, b) => a.name.localeCompare(b.name));
  const groupNames = [...new Set(clients.map(c => c.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  let updatedAt = null;
  try { const { rows: u } = await pool.query('SELECT MAX(synced_at) AS m FROM ticketsmodule_stat_deals'); updatedAt = u[0] && u[0].m; } catch (e) { /* ignore */ }

  return {
    groupsTree,
    audit: { noBdm, orphanP60, multiManager },
    meta: {
      rate, updatedAt, employees, groups: groupNames,
      counts: { clients: clients.length, projects: parents.length, groups: groupsTree.length },
    },
  };
}

// Список клиентов для справочника (компании из зеркала + текущее назначение БДМ/группы).
async function getClientsDirectory() {
  const { rows } = await pool.query(
    `SELECT company_id, MAX(company_name) AS company_name, COUNT(*)::int AS deal_count
       FROM ticketsmodule_stat_deals WHERE company_id IS NOT NULL
      GROUP BY company_id`
  );
  const dir = new Map();
  const { rows: dc } = await pool.query('SELECT company_id, bdm_bitrix_id, group_name FROM ticketsmodule_project_clients');
  dc.forEach(r => dir.set(String(r.company_id), r));
  const items = rows.map(r => {
    const d = dir.get(String(r.company_id));
    return {
      companyId: r.company_id, company: r.company_name, dealCount: r.deal_count,
      bdmId: d ? d.bdm_bitrix_id : null, bdm: d && d.bdm_bitrix_id ? uname(d.bdm_bitrix_id) : null,
      group: d ? d.group_name : null,
    };
  }).sort((a, b) => b.dealCount - a.dealCount);
  return items;
}

// Назначить/обновить БДМ и группу клиента.
async function setClient(companyId, companyName, bdmId, groupName, byUser) {
  await pool.query(
    `INSERT INTO ticketsmodule_project_clients (company_id, company_name, bdm_bitrix_id, group_name, updated_at, updated_by)
     VALUES ($1,$2,$3,$4,NOW(),$5)
     ON CONFLICT (company_id) DO UPDATE SET company_name=$2, bdm_bitrix_id=$3, group_name=$4, updated_at=NOW(), updated_by=$5`,
    [String(companyId), companyName || null, bdmId ? parseInt(bdmId, 10) : null, groupName || null, byUser || null]
  );
}

module.exports = { getProjects, getClientsDirectory, setClient };

// Расчётный слой модуля «Проекты КАМ».
// Модель: привязка сделки к проекту — через поле Битрикса «В рамках проекта»
// (UF_CRM_1791972186, список-значение, ведёт Дмитрий; «Без проекта»/пусто → не
// проект). Проект = значение этого поля; все сделки с одинаковым значением = один
// проект. Компания проекта выводится из сделок; КАМ назначается в ЦУП (справочник
// ticketsmodule_project_kam) — один КАМ на проект. Заменяет «комплексные сделки».
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

// Фаза для модели КАМ: 'pre' — доконтракт P10–P80; 'post' — контракт→завершённые
// (включая WON). Отрицательные (LOST) и прочие стадии → null (в проект не включаем).
function bucketOf(st, stageId) {
  if (st.kind === 'pipeline') return 'pre';
  if (st.kind === 'contract') return 'post';
  return null;
}

async function getProjects() {
  const rate = await getTodayRate();
  const base = dealBaseUrl();
  const url = id => base ? (base + id + '/') : null;
  const sumOf = d => (d.currency_id === 'USD' ? (parseFloat(d.opportunity) || 0) * rate : (parseFloat(d.opportunity) || 0));

  // Только проектные сделки (поле «В рамках проекта» заполнено реальным проектом).
  const { rows } = await pool.query(
    `SELECT deal_id, company_id, company_name, assigned_by_id, stage_id, category_id,
            opportunity, currency_id, department_id, deal_title, project_tag
       FROM ticketsmodule_stat_deals
      WHERE project_tag IS NOT NULL AND project_tag <> ''`
  );

  // Назначения КАМ (проект → КАМ) из справочника ЦУП.
  const kamByProject = new Map();
  try {
    const { rows: km } = await pool.query('SELECT project_tag, kam_bitrix_id FROM ticketsmodule_project_kam');
    km.forEach(r => { if (r.kam_bitrix_id != null) kamByProject.set(r.project_tag, r.kam_bitrix_id); });
  } catch (e) { /* best-effort */ }

  const dealCard = d => {
    const st = stageInfo(d.stage_id);
    return {
      dealId: Number(d.deal_id),
      title: d.deal_title || d.company_name || ('Сделка #' + d.deal_id),
      company: d.company_name || '', companyId: d.company_id || null,
      product: productOf(d), step: st.step, kind: st.kind,
      phase: bucketOf(st, d.stage_id),
      done: /(^|:)WON$/.test(d.stage_id || ''),
      stage: d.stage_id, sum: sumOf(d),
      ownerId: d.assigned_by_id || null, owner: uname(d.assigned_by_id), url: url(d.deal_id),
    };
  };

  // Группировка по проекту.
  const byProject = new Map();
  for (const d of rows) {
    const key = d.project_tag;
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key).push(d);
  }

  const projects = [];
  for (const [project, deals] of byProject) {
    const cards = deals.map(dealCard);
    const pre = cards.filter(c => c.phase === 'pre').sort((a, b) => b.sum - a.sum);
    const post = cards.filter(c => c.phase === 'post').sort((a, b) => b.sum - a.sum);
    // Компания проекта: самая частая среди сделок (один проект = одна компания).
    const compCount = new Map(); // key companyId|name → {companyId, company, n}
    for (const d of deals) {
      const cid = d.company_id ? String(d.company_id) : ('name:' + (d.company_name || '—'));
      if (!compCount.has(cid)) compCount.set(cid, { companyId: d.company_id || null, company: d.company_name || '—', n: 0 });
      compCount.get(cid).n++;
    }
    const comp = [...compCount.values()].sort((a, b) => b.n - a.n)[0] || { companyId: null, company: '—' };
    const companies = [...compCount.values()].map(c => c.company); // все компании проекта (обычно одна)
    const preSum = pre.reduce((s, c) => s + c.sum, 0);
    const postSum = post.reduce((s, c) => s + c.sum, 0);
    const kamId = kamByProject.get(project) || null;
    const products = [...new Set(cards.filter(c => c.phase).map(c => c.product))].sort();
    const managers = [...new Map(cards.filter(c => c.phase && c.ownerId).map(c => [c.ownerId, c.owner])).values()].sort();
    projects.push({
      project, companyId: comp.companyId, company: comp.company, companies,
      kamId, kam: kamId ? uname(kamId) : null,
      pre, post, preSum, postSum, totalSum: preSum + postSum,
      dealCount: pre.length + post.length, products, managers,
    });
  }
  projects.sort((a, b) => b.totalSum - a.totalSum);

  // Вид «По компаниям»: компания → её проекты.
  const byCompany = new Map();
  for (const p of projects) {
    const cid = p.companyId ? String(p.companyId) : ('name:' + p.company);
    if (!byCompany.has(cid)) byCompany.set(cid, { companyId: p.companyId, company: p.company, projects: [] });
    byCompany.get(cid).projects.push(p);
  }
  const companies = [...byCompany.values()].map(c => ({
    ...c, totalSum: c.projects.reduce((s, p) => s + p.totalSum, 0), projectCount: c.projects.length,
  })).sort((a, b) => b.totalSum - a.totalSum);

  // Аудит: проекты без назначенного КАМ.
  const noKam = projects.filter(p => !p.kamId)
    .map(p => ({ project: p.project, company: p.company, dealCount: p.dealCount, totalSum: p.totalSum }));

  // Кандидаты в КАМ (для выпадашки назначения).
  const employees = Object.keys(EMPLOYEE_DEPT).map(id => ({ id: Number(id), name: uname(id), dept: EMPLOYEE_DEPT[id] }))
    .filter(e => e.name && e.name !== ('#' + e.id)).sort((a, b) => a.name.localeCompare(b.name));

  let updatedAt = null;
  try { const { rows: u } = await pool.query('SELECT MAX(synced_at) AS m FROM ticketsmodule_stat_deals'); updatedAt = u[0] && u[0].m; } catch (e) { /* ignore */ }

  const dealTotal = projects.reduce((s, p) => s + p.dealCount, 0);
  return {
    projects, companies,
    audit: { noKam },
    meta: {
      rate, updatedAt, employees,
      counts: { projects: projects.length, companies: companies.length, deals: dealTotal, noKam: noKam.length },
    },
  };
}

// Назначить/снять КАМ на проект.
async function setProjectKam(project, kamId, byUser) {
  if (!project) throw new Error('Не указан проект');
  await pool.query(
    `INSERT INTO ticketsmodule_project_kam (project_tag, kam_bitrix_id, updated_at, updated_by)
     VALUES ($1,$2,NOW(),$3)
     ON CONFLICT (project_tag) DO UPDATE SET kam_bitrix_id=$2, updated_at=NOW(), updated_by=$3`,
    [String(project), kamId ? parseInt(kamId, 10) : null, byUser || null]
  );
}

module.exports = { getProjects, setProjectKam };

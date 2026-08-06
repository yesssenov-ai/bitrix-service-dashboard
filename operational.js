// ─────────────────────────────────────────────────────────────────────────────
// Operational module engine — "Реализация" (execution) view.
//
// Live rebuild of the Power BI «Реализация» tab straight from Bitrix REST:
//   • the stage funnel (Contract → Logistics → … → Завершена) with Сумма|Количество
//   • the detail table (company, contract/title, dates, manager, engineer, terms…)
//   • per-deal drill-down: child smart processes (Закупки/Логистика/…), tasks, comments
//   • meeting flags: overdue delivery, stalled deals, incomplete child processes
//
// Deals in scope = every deal from the contract stage up to завершена, in all
// 4 sales pipelines (the execution phase, i.e. "after the contract is signed").
// ─────────────────────────────────────────────────────────────────────────────
const { b24 } = require('./bitrix');
const { USERS } = require('./constants');
const { SMART_TYPES, findChildrenOfDeal, resolveStageName, getStageSemantics } = require('./relations');

// ── Field codes ──────────────────────────────────────────────────────────────
// Known-good codes are filled in. The ones marked `null` are the custom deal
// fields we still need to confirm via `node discover-deal-fields.js` — the
// engine degrades gracefully (empty column) until a real code is set here.
const F = {
  contractDate:   'UF_CRM_1753708701368', // "Дата договора" — confirmed (stats module)
  instrument:     'UF_CRM_NAME_PRIOBOR',  // instrument name — confirmed
  department:     'UF_CRM_1758005356984', // "Отдел" — confirmed
  contractNo:     null,  // "№ Договора"                 → fill after discovery
  deliveryByDate: null,  // "Поставка по договору" (дата) → fill after discovery
  factoryShip:    null,  // "Отгрузка от завода"   (дата) → fill after discovery
  payTermsFactory:null,  // "Условие оплаты от завода"    → fill after discovery
  payTermsClient: null,  // "Условие оплаты клиента"      → fill after discovery
  engineerId:     null,  // "Инженер" (user field)        → fill after discovery
  comment:        null,  // "Коммент." (last note field)  → optional, we also read timeline
};

// ── Department labels (shared with the stats module) ─────────────────────────
const DEPARTMENT_LABELS = {
  '4857':'Элементный','4858':'Хроматография','4859':'Электрохимия','4860':'Клеточный анализ',
  '4862':'Spares','4863':'Service','4864':'Training','4865':'General Lab','4866':'Complex','8384':'Материаловедение',
};

// ── Pipelines & their execution stages (contract → завершена) ────────────────
// stageEntityId is the crm.status.list ENTITY_ID that holds this pipeline's
// stages; `stages` is the post-contract subset we treat as "operational".
// Names + order + colour are pulled LIVE from Bitrix so the funnel always
// matches the CRM, but this list defines the boundary of what counts.
const PIPELINES = {
  0: { name:'Инструменты',   stageEntityId:'DEAL_STAGE',   stages:['FINAL_INVOICE','1','UC_Q9J6VV','UC_9MBFR2','2','3','WON'] },
  1: { name:'Расходка',      stageEntityId:'DEAL_STAGE_1', stages:['C1:FINAL_INVOICE','C1:1','C1:UC_3MVK90','C1:UC_3SCB5K','C1:2','C1:3','C1:WON'] },
  2: { name:'Тренинг-центр', stageEntityId:'DEAL_STAGE_2', stages:['C2:FINAL_INVOICE','C2:1','C2:2','C2:WON'] },
  3: { name:'Сервис',        stageEntityId:'DEAL_STAGE_3', stages:['C3:FINAL_INVOICE','C3:UC_YYTFYG','C3:2','C3:WON'] },
};

const STALE_DAYS = 14; // no movement for this many days → flagged as "завис"

// ── Live stage metadata (name / colour / semantics / order), cached 1h ───────
const stageMetaCache = new Map(); // categoryId -> { at, list:[{id,name,color,semantics,sort}], byId:{} }
async function getPipelineStages(categoryId) {
  const cached = stageMetaCache.get(categoryId);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached;
  const cfg = PIPELINES[categoryId];
  let byId = {};
  try {
    const { result } = await b24('crm.status.list', {
      filter: { ENTITY_ID: cfg.stageEntityId },
      select: ['STATUS_ID', 'NAME', 'COLOR', 'SEMANTICS', 'SORT'],
    });
    (result || []).forEach(s => {
      byId[s.STATUS_ID] = { id: s.STATUS_ID, name: s.NAME, color: s.COLOR || '#8a8886', semantics: s.SEMANTICS, sort: parseInt(s.SORT, 10) || 0 };
    });
  } catch (e) {
    console.error(`getPipelineStages(${categoryId}) error:`, e.message);
  }
  // Keep only the operational subset, in Bitrix sort order.
  const list = cfg.stages
    .map(id => byId[id] || { id, name: id, color: '#8a8886', semantics: 'P', sort: 9999 })
    .sort((a, b) => a.sort - b.sort);
  const entry = { at: Date.now(), list, byId };
  stageMetaCache.set(categoryId, entry);
  return entry;
}

// ── Batched company-name resolver (one call per ~50 ids, cached) ─────────────
const companyNameCache = new Map();
async function resolveCompanies(ids) {
  const missing = [...new Set(ids.filter(Boolean).map(String))].filter(id => !companyNameCache.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    try {
      let start = 0;
      while (true) {
        const { result, next } = await b24('crm.company.list', { filter: { ID: batch }, select: ['ID', 'TITLE'], start });
        (result || []).forEach(c => companyNameCache.set(String(c.ID), c.TITLE || ''));
        if (next === undefined || next === null) break;
        start = next;
      }
    } catch (e) { console.error('resolveCompanies error:', e.message); }
    batch.forEach(id => { if (!companyNameCache.has(id)) companyNameCache.set(id, ''); });
  }
  const map = {};
  ids.forEach(id => { if (id) map[String(id)] = companyNameCache.get(String(id)) || ''; });
  return map;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function get(deal, code) { return code ? (deal[code] ?? null) : null; }
function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }
function firstOf(v) { return Array.isArray(v) ? (v[0] ?? null) : (v ?? null); }
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}
function daysSince(v) {
  if (!v) return null;
  return Math.floor((Date.now() - new Date(v)) / 86400000);
}

// The set of deal fields we ask Bitrix for (skip nulls).
function selectFields() {
  const base = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
    'COMPANY_ID', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'DATE_MODIFY'];
  const custom = Object.values(F).filter(Boolean);
  return [...new Set([...base, ...custom])];
}

// ── Fetch execution-phase deals across the requested pipelines + filters ─────
// filters: { categoryIds:[], departmentId, managerId, companyId, year, month, stageId }
async function fetchDeals(filters = {}) {
  const cats = (filters.categoryIds && filters.categoryIds.length)
    ? filters.categoryIds.map(Number)
    : Object.keys(PIPELINES).map(Number);

  const all = [];
  for (const categoryId of cats) {
    const cfg = PIPELINES[categoryId];
    if (!cfg) continue;
    const stageFilter = filters.stageId ? [filters.stageId] : cfg.stages;
    const filter = { CATEGORY_ID: String(categoryId), '@STAGE_ID': stageFilter };
    if (filters.managerId)    filter.ASSIGNED_BY_ID = filters.managerId;
    if (filters.companyId)    filter.COMPANY_ID = filters.companyId;
    if (filters.departmentId && F.department) filter[F.department] = filters.departmentId;
    // Year/month filter is applied on the contract date, when present.
    if (filters.year && F.contractDate) {
      const y = filters.year;
      const m = filters.month;
      if (m) {
        const mm = String(m).padStart(2, '0');
        const last = new Date(y, m, 0).getDate();
        filter[`>=${F.contractDate}`] = `${y}-${mm}-01`;
        filter[`<=${F.contractDate}`] = `${y}-${mm}-${last}`;
      } else {
        filter[`>=${F.contractDate}`] = `${y}-01-01`;
        filter[`<=${F.contractDate}`] = `${y}-12-31`;
      }
    }

    let start = 0;
    while (true) {
      let resp;
      try {
        resp = await b24('crm.deal.list', { filter, select: selectFields(), order: { DATE_MODIFY: 'DESC' }, start });
      } catch (e) {
        console.error(`fetchDeals(cat ${categoryId}) error:`, e.message);
        break;
      }
      const items = resp.result || [];
      all.push(...items.map(d => ({ ...d, __categoryId: categoryId })));
      if (resp.next === undefined || resp.next === null) break;
      start = resp.next;
    }
  }
  return all;
}

// ── Map one raw deal to a detail-table row + flags ───────────────────────────
function buildRow(deal, stageMeta, companyMap) {
  const categoryId = Number(deal.__categoryId ?? deal.CATEGORY_ID);
  const stage = stageMeta[categoryId]?.byId?.[deal.STAGE_ID]
    || { name: deal.STAGE_ID, color: '#8a8886', semantics: 'P' };
  const isDone = stage.semantics === 'S';
  const isLost = stage.semantics === 'F';

  const deliveryBy = dateOnly(get(deal, F.deliveryByDate));
  const factoryShip = dateOnly(get(deal, F.factoryShip));
  // "Разница": ship earlier than / on the contract delivery date = on time (✓).
  const diffDays = (deliveryBy && factoryShip) ? daysBetween(deliveryBy, factoryShip) : null;
  const onTime = diffDays === null ? null : diffDays >= 0;

  const engId = get(deal, F.engineerId);
  const engineerId = engId ? parseInt(firstOf(engId), 10) : null;
  const managerId = deal.ASSIGNED_BY_ID ? parseInt(deal.ASSIGNED_BY_ID, 10) : null;

  const deptRaw = get(deal, F.department);
  const departmentId = firstOf(deptRaw);
  const stale = daysSince(deal.DATE_MODIFY);
  const overdueDelivery = !!(deliveryBy && !isDone && !isLost && new Date(deliveryBy) < new Date());

  const flags = [];
  if (overdueDelivery) flags.push('overdue');            // просрочена поставка
  if (!isDone && !isLost && stale !== null && stale >= STALE_DAYS) flags.push('stale'); // завис
  if (onTime === false) flags.push('late-ship');         // отгрузка позже срока

  return {
    id: deal.ID,
    categoryId,
    pipelineName: PIPELINES[categoryId]?.name || '—',
    stageId: deal.STAGE_ID,
    stageName: stage.name,
    stageColor: stage.color,
    isDone, isLost,
    company: companyMap[String(deal.COMPANY_ID)] || '',
    companyId: deal.COMPANY_ID || null,
    title: deal.TITLE || '',
    contractNo: get(deal, F.contractNo) || '',
    deliveryBy, factoryShip, diffDays, onTime,
    managerId, manager: managerId ? (USERS[managerId] || `#${managerId}`) : '',
    engineerId, engineer: engineerId ? (USERS[engineerId] || `#${engineerId}`) : '',
    payFactory: firstOf(get(deal, F.payTermsFactory)) || '',
    payClient: firstOf(get(deal, F.payTermsClient)) || '',
    comment: get(deal, F.comment) || '',
    departmentId: departmentId || null,
    department: DEPARTMENT_LABELS[departmentId] || (departmentId || ''),
    opportunity: parseFloat(deal.OPPORTUNITY) || 0,
    currency: deal.CURRENCY_ID || 'KZT',
    dateModify: deal.DATE_MODIFY || null,
    daysStale: stale,
    flags,
    url: `https://crm.prolabsupport.kz/crm/deal/details/${deal.ID}/`,
  };
}

// ── Build the stage funnel (Сумма | Количество per stage) ────────────────────
function buildFunnel(rows, stageMeta, categoryIds) {
  // When exactly one pipeline is selected, show its real named stages in order.
  // For a multi-pipeline view we fall back to a compact per-pipeline roll-up.
  if (categoryIds && categoryIds.length === 1) {
    const cat = categoryIds[0];
    const stages = stageMeta[cat]?.list || [];
    return {
      mode: 'stages',
      cells: stages.map(s => {
        const inStage = rows.filter(r => r.stageId === s.id);
        return { key: s.id, name: s.name, color: s.color, sum: inStage.reduce((a, r) => a + r.opportunity, 0), count: inStage.length };
      }),
    };
  }
  return {
    mode: 'pipelines',
    cells: (categoryIds && categoryIds.length ? categoryIds : Object.keys(PIPELINES).map(Number)).map(cat => {
      const inCat = rows.filter(r => r.categoryId === cat);
      return { key: cat, name: PIPELINES[cat]?.name || cat, color: '#35d0c0', sum: inCat.reduce((a, r) => a + r.opportunity, 0), count: inCat.length };
    }),
  };
}

// ── Top-level: the whole board for the given filters ─────────────────────────
async function getBoard(filters = {}) {
  const cats = (filters.categoryIds && filters.categoryIds.length)
    ? filters.categoryIds.map(Number)
    : Object.keys(PIPELINES).map(Number);

  // Live stage metadata for each pipeline in view.
  const stageMeta = {};
  for (const cat of cats) stageMeta[cat] = await getPipelineStages(cat);

  const deals = await fetchDeals({ ...filters, categoryIds: cats });
  const companyMap = await resolveCompanies(deals.map(d => d.COMPANY_ID));
  let rows = deals.map(d => buildRow(d, stageMeta, companyMap));

  // Client-side "Заказчик" search (by company name) — kept here so the UI can
  // pass a free-text query without needing a company id.
  if (filters.customerQuery && filters.customerQuery.trim()) {
    const q = filters.customerQuery.trim().toLowerCase();
    rows = rows.filter(r => (r.company || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q));
  }

  const funnel = buildFunnel(rows, stageMeta, cats);

  // Filter option lists for the UI.
  const managerSet = new Map(), deptSet = new Map(), companySet = new Map(), yearSet = new Set();
  rows.forEach(r => {
    if (r.managerId) managerSet.set(r.managerId, r.manager);
    if (r.departmentId) deptSet.set(String(r.departmentId), r.department);
    if (r.companyId) companySet.set(String(r.companyId), r.company);
    // year taken from delivery / modify for the filter list
  });

  const summary = {
    dealCount: rows.length,
    totalSum: rows.reduce((a, r) => a + r.opportunity, 0),
    overdue: rows.filter(r => r.flags.includes('overdue')).length,
    stale: rows.filter(r => r.flags.includes('stale')).length,
    lateShip: rows.filter(r => r.flags.includes('late-ship')).length,
  };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    filters: { categoryIds: cats },
    pipelines: Object.fromEntries(Object.entries(PIPELINES).map(([id, p]) => [id, p.name])),
    departments: DEPARTMENT_LABELS,
    funnel,
    rows,
    summary,
    options: {
      managers: [...managerSet.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      departments: [...deptSet.entries()].map(([id, name]) => ({ id, name })),
      companies: [...companySet.entries()].map(([id, name]) => ({ id, name })).filter(c => c.name).sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    },
    fieldsReady: Object.fromEntries(Object.entries(F).map(([k, v]) => [k, !!v])),
  };
}

// ── Per-deal drill-down: child smart processes, tasks, timeline comments ─────
async function getDealDetail(dealId) {
  const [children, tasks, comments] = await Promise.all([
    getChildProcesses(dealId),
    getDealTasks(dealId),
    getDealComments(dealId),
  ]);
  return { ok: true, dealId, children, tasks, comments };
}

async function getChildProcesses(dealId) {
  const raw = await findChildrenOfDeal(dealId);
  const out = [];
  for (const c of raw) {
    let stageName = c.stageId, semantics = 'P';
    try {
      const info = await resolveStageName(c.entityTypeId, c.categoryId, c.stageId);
      stageName = info.name; semantics = info.semantics || 'P';
    } catch (e) { /* keep raw */ }
    out.push({
      entityTypeId: c.entityTypeId,
      entityName: SMART_TYPES[c.entityTypeId]?.name || c.entityName || `Тип ${c.entityTypeId}`,
      id: c.id, title: c.title || `#${c.id}`,
      stageId: c.stageId, stageName, semantics,
      done: semantics === 'S', failed: semantics === 'F',
      createdTime: c.createdTime || null,
      url: `https://crm.prolabsupport.kz/crm/type/${c.entityTypeId}/details/${c.id}/`,
    });
  }
  return out;
}

async function getDealTasks(dealId) {
  try {
    const { result } = await b24('tasks.task.list', {
      filter: { UF_CRM_TASK: `D_${dealId}` },
      select: ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'DEADLINE', 'CLOSED_DATE', 'CREATED_DATE'],
      order: { DEADLINE: 'ASC' },
    });
    const tasks = result?.tasks || result || [];
    const now = Date.now();
    return tasks.map(t => {
      const status = parseInt(t.status ?? t.STATUS, 10); // 5 = completed, 4 = ready-to-review, 2/3 pending
      const deadline = t.deadline ?? t.DEADLINE ?? null;
      const done = status === 5;
      const overdue = !done && deadline && new Date(deadline).getTime() < now;
      const respId = parseInt(t.responsibleId ?? t.RESPONSIBLE_ID, 10);
      return {
        id: t.id ?? t.ID,
        title: t.title ?? t.TITLE,
        status, done, overdue, deadline,
        responsibleId: respId, responsible: respId ? (USERS[respId] || `#${respId}`) : '',
        url: `https://crm.prolabsupport.kz/company/personal/user/${respId}/tasks/task/view/${t.id ?? t.ID}/`,
      };
    });
  } catch (e) {
    console.error(`getDealTasks(${dealId}) error:`, e.message);
    return [];
  }
}

async function getDealComments(dealId, limit = 15) {
  try {
    const { result } = await b24('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      order: { CREATED: 'DESC' },
    });
    const items = (result || []).slice(0, limit);
    return items.map(c => {
      const authorId = parseInt(c.AUTHOR_ID, 10);
      return {
        id: c.ID,
        date: c.CREATED || null,
        authorId, author: authorId ? (USERS[authorId] || `#${authorId}`) : '',
        text: (c.COMMENT || '').replace(/\[[^\]]+\]/g, '').trim(),
      };
    }).filter(c => c.text);
  } catch (e) {
    console.error(`getDealComments(${dealId}) error:`, e.message);
    return [];
  }
}

module.exports = {
  F, PIPELINES, DEPARTMENT_LABELS,
  getBoard, getDealDetail, getChildProcesses, getDealTasks, getDealComments,
  getPipelineStages, fetchDeals, buildRow,
};

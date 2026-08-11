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
const { pool } = require('./auth');
const { USERS } = require('./constants');
const { SMART_TYPES, findChildrenOfDeal, resolveStageName, getStageSemantics, buildTree } = require('./relations');

// ── Field codes ──────────────────────────────────────────────────────────────
// Known-good codes are filled in. The ones marked `null` are the custom deal
// fields we still need to confirm via `node discover-deal-fields.js` — the
// engine degrades gracefully (empty column) until a real code is set here.
const F = {
  contractDate:   'UF_CRM_1753708701368', // "Дата договора"
  instrument:     'UF_CRM_NAME_PRIOBOR',  // instrument name
  department:     'UF_CRM_1758005356984', // "Отдел" (enumeration)
  contractNo:     'UF_CRM_1759391990160', // "Номер договора"
  deliveryByDate: 'UF_CRM_1731864823359', // "Срок поставки заказа по договору"
  // Отгрузка/оплаты/инженер больше НЕ берутся с полей сделки — они тянутся из
  // дочерних смартов Закупки(1066)/Заявка на сервис(1058) в operational-sync.
  factoryShip:    null,
  payTermsFactory:null,
  payTermsClient: null,
  engineerId:     null,
  comment:        'UF_CRM_1752737600889', // "Статус сделки (комментарий)"
  redFlag:        'UF_CRM_1752737638930', // "Красный флаг" (boolean)
};

// Enum-like deal fields whose stored value is an ID we must resolve to a label.
const ENUM_FIELDS = ['UF_CRM_1744195326183', 'UF_CRM_1731864478'];

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
// Execution stages ONLY — from the contract stage up to (but NOT including)
// the final "Завершена"/WON stage. Completed deals are intentionally excluded
// from the operational module: they aren't fetched, shown, or cached.
const PIPELINES = {
  0: { name:'Инструменты',   stageEntityId:'DEAL_STAGE',   stages:['FINAL_INVOICE','1','UC_Q9J6VV','UC_9MBFR2','2','3'] },
  1: { name:'Расходка',      stageEntityId:'DEAL_STAGE_1', stages:['C1:FINAL_INVOICE','C1:1','C1:UC_3MVK90','C1:UC_3SCB5K','C1:2','C1:3'] },
  2: { name:'Тренинг-центр', stageEntityId:'DEAL_STAGE_2', stages:['C2:FINAL_INVOICE','C2:1','C2:2'] },
  3: { name:'Сервис',        stageEntityId:'DEAL_STAGE_3', stages:['C3:FINAL_INVOICE','C3:UC_YYTFYG','C3:2'] },
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
  // Keep only the operational subset, in Bitrix sort order — and defensively
  // drop any success/fail (завершённая/провальная) stage that might slip in.
  const list = cfg.stages
    .map(id => byId[id] || { id, name: id, color: '#8a8886', semantics: 'P', sort: 9999 })
    .filter(s => s.semantics !== 'S' && s.semantics !== 'F')
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

// ── Enum/iblock label resolver (id → human label), cached 1h ─────────────────
let dealFieldsCache = null, dealFieldsAt = 0;
async function getDealFields() {
  if (dealFieldsCache && Date.now() - dealFieldsAt < 60 * 60 * 1000) return dealFieldsCache;
  try {
    const { result } = await b24('crm.deal.fields', {});
    dealFieldsCache = result || {};
    dealFieldsAt = Date.now();
  } catch (e) {
    console.error('getDealFields error:', e.message);
    if (!dealFieldsCache) dealFieldsCache = {};
  }
  return dealFieldsCache;
}
async function buildEnumMap(code) {
  const field = (await getDealFields())[code];
  const map = {};
  (field?.items || []).forEach(i => { map[String(i.ID)] = i.VALUE; });
  return map;
}

// ── Bitrix user map (id → ФИО), cached 6h ────────────────────────────────────
// The hardcoded USERS dict in constants.js is incomplete (stops around id 90),
// so managers/engineers with newer Bitrix ids showed as "#92". Pull the full
// live directory instead — resolves everyone, including future hires.
let userMapCache = null, userMapAt = 0;
async function getUserMap() {
  if (userMapCache && Date.now() - userMapAt < 6 * 60 * 60 * 1000) return userMapCache;
  const map = {};
  try {
    let start = 0;
    for (let i = 0; i < 200; i++) {
      const resp = await b24('user.get', { start });
      const users = resp.result || [];
      users.forEach(u => {
        const name = `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim();
        if (name) map[String(u.ID)] = name;
      });
      if (resp.next === undefined || resp.next === null) break;
      start = resp.next;
    }
    userMapCache = map; userMapAt = Date.now();
  } catch (e) {
    console.error('getUserMap error:', e.message);
    if (!userMapCache) userMapCache = map;
  }
  return userMapCache;
}
function resolveUser(id, userMap) {
  if (!id) return '';
  return (userMap && userMap[String(id)]) || USERS[id] || `#${id}`;
}

// ── Payment-terms resolution ─────────────────────────────────────────────────
// Supplier side is a plain enumeration (confirmed via discover-deal-fields.js).
const PAY_SUPPLIER_LABELS = {
  '3585': '100% оплата', '3586': 'Частичная предоплата',
  '3587': 'Постоплата с отсрочкой', '3588': 'Нулевая стоимость',
};
// Client side (UF_CRM_1731864478) is an iblock_element in IBLOCK_ID=21 — a plain
// infoblock, NOT a lists-module list, so it can't be read via REST (confirmed
// with probe-scan.js: lists.get doesn't see iblock 21). Only 4 element ids are
// ever used (83/84/85/86), so hard-map them here.
// ⚠️ ПРОВЕРЬ названия по примерам сделок и поправь строки при необходимости:
//    85 → #105227, 83 → #106941, 84 → #97024, 86 → #107178
const CLIENT_PAY_LABELS = {
  '85': 'Постоплата с отсрочкой',   // 246 сделок
  '83': '100% оплата',              // 137 сделок
  '84': 'Частичная предоплата',     // 63 сделки
  '86': 'Нулевая стоимость',        // 7 сделок
};
async function getClientPayMap() { return CLIENT_PAY_LABELS; }

// ── Bizproc automations (only ACTIVE/running instances are exposed by REST) ───
let bpTplCache = null, bpTplAt = 0;
async function getBizprocTemplates() {
  if (bpTplCache && Date.now() - bpTplAt < 6 * 60 * 60 * 1000) return bpTplCache;
  const map = {};
  try {
    let start = 0;
    for (let i = 0; i < 50; i++) {
      const r = await b24('bizproc.workflow.template.list', { select: ['ID', 'NAME'], start });
      (r.result || []).forEach(t => { map[String(t.ID)] = t.NAME; });
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    bpTplCache = map; bpTplAt = Date.now();
  } catch (e) { console.error('getBizprocTemplates error:', e.message); if (!bpTplCache) bpTplCache = map; }
  return bpTplCache;
}
let bpInstCache = null, bpInstAt = 0;
async function getActiveBizproc(force = false) {
  if (!force && bpInstCache && Date.now() - bpInstAt < 2 * 60 * 1000) return bpInstCache;
  const list = [];
  try {
    let start = 0;
    for (let i = 0; i < 200; i++) {
      const r = await b24('bizproc.workflow.instances', { select: ['ID', 'DOCUMENT_ID', 'TEMPLATE_ID', 'STARTED', 'MODIFIED'], start });
      list.push(...(r.result || []));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    bpInstCache = list; bpInstAt = Date.now();
  } catch (e) { console.error('getActiveBizproc error:', e.message); if (!bpInstCache) bpInstCache = list; }
  return bpInstCache;
}
// The set of bizproc DOCUMENT_IDs that belong to a deal + its child smart items.
function bpDocIds(dealId, children) {
  const set = new Set([`DEAL_${dealId}`]);
  (children || []).forEach(c => { if (c.entityTypeId && c.id) set.add(`DYNAMIC_${c.entityTypeId}_${c.id}`); });
  return set;
}
// Шаблоны БП, которые вообще не показываем и не считаем (фоновые/шумные).
const BP_TEMPLATE_HIDE = new Set(['85']); // «Регистрация контрактов» — вечный авто-БП, 451 экз.
function matchActiveBp(instances, dealId, children, tplMap) {
  const wanted = bpDocIds(dealId, children);
  return (instances || []).filter(w => wanted.has(String(w.DOCUMENT_ID)) && !BP_TEMPLATE_HIDE.has(String(w.TEMPLATE_ID))).map(w => ({
    id: w.ID, name: (tplMap && tplMap[String(w.TEMPLATE_ID)]) || `Шаблон #${w.TEMPLATE_ID}`,
    documentId: w.DOCUMENT_ID, started: w.STARTED || null,
  }));
}
async function getActiveBpForDeal(dealId, children, tpl, inst) {
  return matchActiveBp(inst, dealId, children, tpl);
}

// Pending bizproc tasks (approval/review steps) grouped by workflow — this is
// what tells us WHO an active BP is currently waiting on, and its human name.
let bpTaskCache = null, bpTaskAt = 0;
async function getBizprocTasksByWorkflow() {
  if (bpTaskCache && Date.now() - bpTaskAt < 2 * 60 * 1000) return bpTaskCache;
  const map = {};
  try {
    let start = 0;
    for (let i = 0; i < 200; i++) {
      const r = await b24('bizproc.task.list', { select: ['ID', 'WORKFLOW_ID', 'NAME', 'USERS', 'MODIFIED'], start });
      (r.result || []).forEach(t => {
        const wf = String(t.WORKFLOW_ID);
        if (!map[wf]) map[wf] = [];
        const users = (Array.isArray(t.USERS) ? t.USERS : [])
          .map(u => parseInt(String(u).replace(/\D/g, ''), 10)).filter(Boolean);
        map[wf].push({ taskId: t.ID, name: t.NAME || '', users });
      });
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    bpTaskCache = map; bpTaskAt = Date.now();
  } catch (e) { console.error('getBizprocTasksByWorkflow error:', e.message); if (!bpTaskCache) bpTaskCache = map; }
  return bpTaskCache;
}
// Friendly names for bizproc templates that aren't returned by
// bizproc.workflow.template.list (deleted/hidden) — fill in as needed.
const BP_TEMPLATE_OVERRIDES = {
  // '85': 'Гарантия по контракту',   // ← 451 экз. на Регистрации контрактов (1036); впиши точное имя, если знаешь
};
function bpDocTypeLabel(documentId) {
  if (/^DEAL_\d+$/.test(String(documentId))) return 'Сделка';
  const yn = String(documentId).match(/^DYNAMIC_(\d+)_(\d+)$/);
  if (yn) return SMART_TYPES[Number(yn[1])]?.name || `Тип ${yn[1]}`;
  return 'документ';
}
// Build a clickable link to the CRM entity a bizproc runs on.
function bpDocUrl(documentId) {
  const dm = String(documentId).match(/^DEAL_(\d+)$/);
  if (dm) return `https://crm.prolabsupport.kz/crm/deal/details/${dm[1]}/`;
  const yn = String(documentId).match(/^DYNAMIC_(\d+)_(\d+)$/);
  if (yn) return `https://crm.prolabsupport.kz/crm/type/${yn[1]}/details/${yn[2]}/`;
  return null;
}
// Rich active-BP list for the drill-down: real name (task step > template),
// who it's waiting on, and a link into the entity where it runs.
async function getActiveBpDetailed(dealId, children, userMap) {
  const [tpl, inst, taskMap] = await Promise.all([
    getBizprocTemplates(), getActiveBizproc(), getBizprocTasksByWorkflow(),
  ]);
  const wanted = bpDocIds(dealId, children);
  return (inst || []).filter(w => wanted.has(String(w.DOCUMENT_ID)) && !BP_TEMPLATE_HIDE.has(String(w.TEMPLATE_ID))).map(w => {
    const tasks = taskMap[String(w.ID)] || [];
    const assignees = [...new Set(tasks.flatMap(t => t.users || []))].map(id => resolveUser(id, userMap)).filter(Boolean);
    const taskName = tasks.map(t => t.name).filter(Boolean)[0];
    const templateName = tpl[String(w.TEMPLATE_ID)] || BP_TEMPLATE_OVERRIDES[String(w.TEMPLATE_ID)];
    // Current waiting step(s) — the mini-journal line «шаг → Выполняется → ждёт X».
    const steps = tasks.map(t => ({
      name: t.name || templateName || 'Шаг БП',
      waitsFor: (t.users || []).map(id => resolveUser(id, userMap)).filter(Boolean),
    }));
    return {
      id: w.ID,
      name: taskName || templateName || `Автоматизация · ${bpDocTypeLabel(w.DOCUMENT_ID)}`,
      template: templateName || `Шаблон #${w.TEMPLATE_ID}`,
      waiting: tasks.length > 0,               // требует действия (есть задание)
      steps, assignees, started: w.STARTED || null,
      url: bpDocUrl(w.DOCUMENT_ID), documentId: w.DOCUMENT_ID,
    };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function get(deal, code) { return code ? (deal[code] ?? null) : null; }
function truthyBool(v) { const s = String(firstOf(v)); return s === '1' || s === 'Y' || s === 'true'; }
function dateOnly(v) { return v ? String(v).slice(0, 10) : null; }
function firstOf(v) { return Array.isArray(v) ? (v[0] ?? null) : (v ?? null); }
function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(a) - new Date(b)) / 86400000);
}
// Postgres DATE columns come back from node-pg as JS Date objects, so
// String(v).slice(0,10) yields "Tue Sep 22" (year dropped) and any date math
// silently collapses to a single year. Normalise to 'YYYY-MM-DD' first so the
// year is preserved across year boundaries.
function toYMD(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}
// Bitrix returns emoji inside timeline comments as ":<utf8-hex-bytes>:" tokens
// (e.g. 💬 → ":f09f92ac:"). Decode those back to the actual character; leave
// ordinary ":word:" text untouched (letters aren't valid hex, odd-length or
// non-UTF8 byte runs fail the round-trip check and are kept as-is).
function decodeBitrixEmoji(s) {
  // Emoji encode as 4-byte UTF-8 (≥8 hex chars); requiring 8+ avoids decoding
  // short accidental hex words like ":dead:" that happen to be valid UTF-8.
  return String(s || '').replace(/:([0-9a-fA-F]{8,32}):/g, (m, hex) => {
    if (hex.length % 2) return m;
    try {
      const buf = Buffer.from(hex, 'hex');
      const dec = buf.toString('utf8');
      if (Buffer.from(dec, 'utf8').toString('hex') === hex.toLowerCase() && /[^\x00-\x7F]/.test(dec)) return dec;
    } catch (e) { /* not an emoji token */ }
    return m;
  });
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
function buildRow(deal, stageMeta, companyMap, enumMaps = {}) {
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
  const redFlag = truthyBool(get(deal, F.redFlag));

  const payFactoryRaw = firstOf(get(deal, F.payTermsFactory));
  const payClientRaw = firstOf(get(deal, F.payTermsClient));
  const payFactory = (enumMaps[F.payTermsFactory]?.[String(payFactoryRaw)]) || (payFactoryRaw || '');
  const payClient = (enumMaps[F.payTermsClient]?.[String(payClientRaw)]) || (payClientRaw || '');

  const flags = [];
  if (redFlag) flags.push('red');                        // красный флаг (ручной)
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
    payFactory, payClient, redFlag,
    comment: firstOf(get(deal, F.comment)) || '',
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

// ── Map a cached DB row → board row (+ computed flags) ───────────────────────
function dbRowToBoard(r, stageMeta, userMap = {}) {
  const categoryId = Number(r.category_id);
  const semantic = r.stage_semantic || stageMeta[categoryId]?.byId?.[r.stage_id]?.semantics || 'P';
  const stage = stageMeta[categoryId]?.byId?.[r.stage_id] || { name: r.stage_id, color: '#8a8886' };
  const isDone = semantic === 'S';
  const isLost = semantic === 'F';

  const deliveryBy = toYMD(r.delivery_by_date);
  const factoryShip = toYMD(r.factory_ship_date);
  // Разница = (Поставка по договору − Отгрузка от завода) − 15 дней.
  const diffDays = (deliveryBy && factoryShip) ? (daysBetween(deliveryBy, factoryShip) - 15) : null;
  const onTime = diffDays === null ? null : diffDays >= 0;
  const stale = daysSince(r.date_modify);
  const overdueDelivery = !!(deliveryBy && !isDone && !isLost && new Date(deliveryBy) < new Date());

  const flags = [];
  if (r.red_flag) flags.push('red');
  if (overdueDelivery) flags.push('overdue');
  if (!isDone && !isLost && stale !== null && stale >= STALE_DAYS) flags.push('stale');
  if (onTime === false) flags.push('late-ship');
  if ((r.open_processes || 0) > 0) flags.push('open-proc');
  if ((r.overdue_tasks || 0) > 0) flags.push('overdue-task');
  if ((r.open_bp || 0) > 0) flags.push('open-bp');

  const managerId = r.assigned_by_id || null;
  const engineerId = r.engineer_id || null;
  return {
    id: r.deal_id, categoryId, pipelineName: PIPELINES[categoryId]?.name || '—',
    stageId: r.stage_id, stageName: stage.name, stageColor: stage.color, isDone, isLost,
    company: r.company_name || '', companyId: r.company_id || null,
    title: r.deal_title || '', contractNo: r.contract_no || '',
    deliveryBy, factoryShip, diffDays, onTime,
    managerId, manager: resolveUser(managerId, userMap),
    engineerId, engineer: resolveUser(engineerId, userMap),
    payFactory: r.pay_factory || '', payClient: r.pay_client || '', redFlag: !!r.red_flag,
    comment: r.comment || '',
    departmentId: r.department_id || null,
    department: DEPARTMENT_LABELS[r.department_id] || (r.department_id || ''),
    opportunity: parseFloat(r.opportunity) || 0, currency: r.currency_id || 'KZT',
    dateModify: r.date_modify || null, daysStale: stale,
    openProcesses: r.open_processes || 0, overdueTasks: r.overdue_tasks || 0, totalTasks: r.total_tasks || 0,
    openBp: r.open_bp || 0,
    flags,
    url: `https://crm.prolabsupport.kz/crm/deal/details/${r.deal_id}/`,
  };
}

async function getSyncMeta() {
  try {
    const { rows } = await pool.query('SELECT last_full_sync, deal_count, last_source FROM ticketsmodule_operational_meta WHERE id=1');
    if (!rows.length) return { lastFullSync: null, dealCount: 0, source: null };
    return { lastFullSync: rows[0].last_full_sync, dealCount: rows[0].deal_count, source: rows[0].last_source };
  } catch (e) { return { lastFullSync: null, dealCount: 0, source: null }; }
}

// ── Top-level: the whole board, read from the Postgres cache (instant) ───────
async function getBoard(filters = {}) {
  const cats = (filters.categoryIds && filters.categoryIds.length)
    ? filters.categoryIds.map(Number)
    : Object.keys(PIPELINES).map(Number);

  // Live stage metadata for each pipeline in view (cached, cheap).
  const stageMeta = {};
  for (const cat of cats) stageMeta[cat] = await getPipelineStages(cat);

  const where = ['category_id = ANY($1)'];
  const params = [cats];
  // Все списочные фильтры — множественный выбор (массив значений → ANY / IN).
  if (filters.stageIds && filters.stageIds.length)      { params.push(filters.stageIds);            where.push(`stage_id = ANY($${params.length})`); }
  if (filters.managerIds && filters.managerIds.length)  { params.push(filters.managerIds);          where.push(`assigned_by_id = ANY($${params.length})`); }
  if (filters.companyId)                                { params.push(filters.companyId);           where.push(`company_id = $${params.length}`); }
  if (filters.departmentIds && filters.departmentIds.length) { params.push(filters.departmentIds.map(String)); where.push(`department_id = ANY($${params.length})`); }
  if (filters.years && filters.years.length)   { params.push(filters.years);  where.push(`EXTRACT(YEAR FROM contract_date)::int = ANY($${params.length}::int[])`); }
  if (filters.months && filters.months.length) { params.push(filters.months); where.push(`EXTRACT(MONTH FROM contract_date)::int = ANY($${params.length}::int[])`); }
  if (filters.customerQuery && filters.customerQuery.trim()) {
    params.push('%' + filters.customerQuery.trim().toLowerCase() + '%');
    const n = params.length;
    where.push(`(LOWER(company_name) LIKE $${n} OR LOWER(deal_title) LIKE $${n} OR LOWER(COALESCE(contract_no,'')) LIKE $${n})`);
  }

  let dbRows = [];
  try {
    const res = await pool.query(
      `SELECT * FROM ticketsmodule_operational_deals WHERE ${where.join(' AND ')} ORDER BY date_modify DESC NULLS LAST`,
      params
    );
    dbRows = res.rows;
  } catch (e) {
    console.error('getBoard DB read error:', e.message);
  }

  const userMap = await getUserMap();
  const rows = dbRows.map(r => dbRowToBoard(r, stageMeta, userMap));
  const funnel = buildFunnel(rows, stageMeta, cats);

  // Filter dropdown options are built from the WHOLE pipeline scope (only the
  // selected воронки), NOT from the already-filtered rows — otherwise choosing a
  // stage with 0 matches would empty the Отдел/Менеджер lists and silently drop
  // those selections. Now picking an empty stage just shows «0 сделок».
  const managerSet = new Map(), deptSet = new Map(), companySet = new Map();
  try {
    const opt = await pool.query(
      `SELECT DISTINCT assigned_by_id, department_id, company_id, company_name
         FROM ticketsmodule_operational_deals WHERE category_id = ANY($1)`, [cats]);
    opt.rows.forEach(o => {
      if (o.assigned_by_id) managerSet.set(o.assigned_by_id, resolveUser(o.assigned_by_id, userMap));
      if (o.department_id) deptSet.set(String(o.department_id), DEPARTMENT_LABELS[o.department_id] || String(o.department_id));
      if (o.company_id) companySet.set(String(o.company_id), o.company_name || '');
    });
  } catch (e) {
    console.error('getBoard options query error:', e.message);
    // Fallback to row-derived options so the dropdowns aren't empty on error.
    rows.forEach(r => {
      if (r.managerId) managerSet.set(r.managerId, r.manager);
      if (r.departmentId) deptSet.set(String(r.departmentId), r.department);
      if (r.companyId) companySet.set(String(r.companyId), r.company);
    });
  }

  const summary = {
    dealCount: rows.length,
    totalSum: rows.reduce((a, r) => a + r.opportunity, 0),
    overdue: rows.filter(r => r.flags.includes('overdue')).length,
    stale: rows.filter(r => r.flags.includes('stale')).length,
    lateShip: rows.filter(r => r.flags.includes('late-ship')).length,
    redFlag: rows.filter(r => r.redFlag).length,
    openProc: rows.filter(r => r.flags.includes('open-proc')).length,
    overdueTask: rows.filter(r => r.flags.includes('overdue-task')).length,
    openBp: rows.filter(r => r.flags.includes('open-bp')).length,
  };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    lastSync: await getSyncMeta(),
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

// ── Per-deal drill-down: child smart processes (nested ladder), tasks, comments ─
// Live build (hits Bitrix). Wrapped by getDealDetail's cache below.
async function buildDealDetailLive(dealId) {
  const userMap = await getUserMap();
  const [tree, tasks, comments] = await Promise.all([
    buildTree('deal', dealId),                 // resolves real stage names + parent-child nesting
    getDealTasks(dealId, userMap),
    getDealComments(dealId, 15, userMap),
  ]);
  const processes = tree ? flattenProcessTree(tree.children || [], 0, userMap) : [];
  const automations = await getActiveBpDetailed(dealId, processes, userMap).catch(() => []);
  return { dealId, processes, tasks, comments, automations };
}

// Cached drill-down: served instantly from Postgres. Built lazily on first open,
// rebuilt on force (the «↻ Обновить» button), invalidated by the deal webhook.
async function getDealDetail(dealId, force = false) {
  if (!force) {
    try {
      const { rows } = await pool.query('SELECT detail, synced_at FROM ticketsmodule_operational_detail WHERE deal_id=$1', [dealId]);
      if (rows.length) return { ok: true, cached: true, syncedAt: rows[0].synced_at, ...rows[0].detail };
    } catch (e) { console.error('getDealDetail cache read:', e.message); }
  }
  const detail = await buildDealDetailLive(dealId);
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_operational_detail (deal_id, detail, synced_at) VALUES ($1,$2,NOW())
       ON CONFLICT (deal_id) DO UPDATE SET detail=$2, synced_at=NOW()`,
      [dealId, JSON.stringify(detail)]
    );
  } catch (e) { console.error('getDealDetail cache write:', e.message); }
  return { ok: true, cached: false, syncedAt: new Date().toISOString(), ...detail };
}

// Drop the cached drill-down for a deal (called from the webhook on change).
async function invalidateDealDetail(dealId) {
  try { await pool.query('DELETE FROM ticketsmodule_operational_detail WHERE deal_id=$1', [dealId]); }
  catch (e) { console.error('invalidateDealDetail:', e.message); }
}

// Flatten the buildTree hierarchy into a depth-tagged list so the UI can render
// the ladder (Запланированные работы → Заявка на сервис, Закупки → Логистика …).
// serviceBadge distinguishes the two deal-level «Заявка на сервис» items
// (Подготовка документов vs Подбор допов); responsible shows who's assigned.
function flattenProcessTree(nodes, depth, userMap = {}) {
  const out = [];
  for (const n of nodes) {
    const sem = n.stageSemantics || 'P';
    const respId = n.assignedById ? parseInt(n.assignedById, 10) : null;
    out.push({
      entityTypeId: n.entityTypeId,
      entityName: n.entityName || SMART_TYPES[n.entityTypeId]?.name || `Тип ${n.entityTypeId}`,
      id: n.id, title: n.title || `#${n.id}`,
      stageName: n.stageName || n.stageId, semantics: sem,
      done: sem === 'S', failed: sem === 'F',
      serviceBadge: Array.isArray(n.serviceBadge) ? n.serviceBadge : (n.serviceBadge ? [n.serviceBadge] : null),
      responsibleId: respId, responsible: respId ? resolveUser(respId, userMap) : '',
      url: n.url || `https://crm.prolabsupport.kz/crm/type/${n.entityTypeId}/details/${n.id}/`,
      depth,
    });
    if (n.children && n.children.length) out.push(...flattenProcessTree(n.children, depth + 1, userMap));
  }
  return out;
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

// Bitrix task statuses: 2 ждёт, 3 выполняется, 4 ждёт контроля, 5 завершена,
// 6 отложена, 7 отклонена (1 «новая» встречается редко).
const TASK_STATUS_LABELS = { 1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена' };

async function getDealTasks(dealId, userMap = {}) {
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
        status, statusLabel: TASK_STATUS_LABELS[status] || ('статус ' + status),
        done, overdue, deadline,
        closedDate: t.closedDate ?? t.CLOSED_DATE ?? null,
        responsibleId: respId, responsible: resolveUser(respId, userMap),
        url: `https://crm.prolabsupport.kz/company/personal/user/${respId}/tasks/task/view/${t.id ?? t.ID}/`,
      };
    });
  } catch (e) {
    console.error(`getDealTasks(${dealId}) error:`, e.message);
    return [];
  }
}

async function getDealComments(dealId, limit = 15, userMap = {}) {
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
        authorId, author: resolveUser(authorId, userMap),
        text: decodeBitrixEmoji((c.COMMENT || '').replace(/\[[^\]]+\]/g, '')).trim(),
      };
    }).filter(c => c.text);
  } catch (e) {
    console.error(`getDealComments(${dealId}) error:`, e.message);
    return [];
  }
}

// ── Edit metadata for the admin panel (all stages per pipeline + user list) ──
async function getAllStages(categoryId) {
  const meta = await getPipelineStages(categoryId);
  return Object.values(meta.byId || {})
    .sort((a, b) => a.sort - b.sort)
    .map(s => ({ id: s.id, name: s.name, color: s.color, semantics: s.semantics }));
}
async function getEditMeta() {
  const userMap = await getUserMap();
  const users = Object.entries(userMap)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const stages = {};
  for (const cat of Object.keys(PIPELINES).map(Number)) stages[cat] = await getAllStages(cat);
  return { users, stages };
}

module.exports = {
  F, PIPELINES, DEPARTMENT_LABELS, ENUM_FIELDS, STALE_DAYS, PAY_SUPPLIER_LABELS, CLIENT_PAY_LABELS,
  getEditMeta, getAllStages,
  getBoard, getDealDetail, getChildProcesses, getDealTasks, getDealComments,
  getPipelineStages, fetchDeals, buildRow, buildEnumMap, resolveCompanies,
  getSyncMeta, dbRowToBoard,
  getClientPayMap, getBizprocTemplates, getActiveBizproc, matchActiveBp, getActiveBpDetailed,
  getBizprocTasksByWorkflow, invalidateDealDetail,
};

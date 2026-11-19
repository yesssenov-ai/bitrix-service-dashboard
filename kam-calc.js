// ─────────────────────────────────────────────────────────────────────────────
// Модуль «КАМ» — расчётная логика (READ-слой).
// Иерархия: Группа компаний → Компания → [Подразделение]? → Проекты → сделки.
// Источники: зеркало сделок ticketsmodule_stat_deals (company_id, company_name,
// group_ref, unit_tag, project_tag, assigned_by_id, opportunity, contract_date),
// реестр подразделений ticketsmodule_kam_units, назначения КАМ ticketsmodule_kam_assign.
// КАМ назначается гибко (group/company/unit) и наследуется вниз.
// Пре/пост-контракт определяем по наличию contract_date (есть → после контракта).
// ─────────────────────────────────────────────────────────────────────────────
const { pool } = require('./auth');
const { b24 } = require('./bitrix');
const { USERS } = require('./constants');

const uname = bid => (bid != null ? (USERS[bid] || ('#' + bid)) : null);
const mln = v => Math.round((Number(v) || 0) / 1e6);

// ── Резолв названия группы (UF_CRM_1731862481, iblock_element) ───────────────
// Пробуем справочник project_clients.group_name (уже ведётся), иначе резолвим
// id элемента через настройки поля + lists.element.get. Кэш 1 час.
let groupMapCache = null, groupMapAt = 0;
async function resolveGroupMap() {
  if (groupMapCache && Date.now() - groupMapAt < 3600 * 1000) return groupMapCache;
  const map = {};
  try {
    const { result: fields } = await b24('crm.deal.fields', {});
    const f = fields && fields['UF_CRM_1731862481'];
    const st = (f && (f.settings || f.SETTINGS)) || {};
    const iblockId = st.IBLOCK_ID || st.iblockId;
    const iblockType = st.IBLOCK_TYPE_ID || st.iblockTypeId || 'lists';
    if (iblockId) {
      let start = 0, guard = 0;
      while (guard++ < 40) {
        const r = await b24('lists.element.get', { IBLOCK_TYPE_ID: iblockType, IBLOCK_ID: iblockId, select: ['ID', 'NAME'], start });
        const items = (r && r.result) || [];
        items.forEach(i => { map[String(i.ID)] = i.NAME; });
        if (r && r.next != null) start = r.next; else break;
      }
    }
  } catch (e) { /* best-effort: имя возьмём из project_clients */ }
  groupMapCache = map; groupMapAt = Date.now();
  return map;
}

async function groupNameOf(groupRef, pcGroup) {
  if (pcGroup) return pcGroup;
  if (!groupRef) return null;
  const map = await resolveGroupMap();
  return map[String(groupRef)] || ('Группа #' + groupRef);
}

// Назначения КАМ (level, node_key) → kam_bitrix_id
async function loadAssignments() {
  const { rows } = await pool.query('SELECT level, node_key, kam_bitrix_id FROM ticketsmodule_kam_assign');
  const m = { group: {}, company: {}, unit: {} };
  rows.forEach(r => { if (m[r.level]) m[r.level][r.node_key] = r.kam_bitrix_id; });
  return m;
}

// Загружаем зеркало сделок + справочники, строим нормализованную модель.
async function loadModel() {
  const [{ rows: deals }, { rows: pcs }, { rows: units }, assign] = await Promise.all([
    pool.query(`SELECT deal_id, company_id, company_name, group_ref, unit_tag, project_tag,
                       assigned_by_id, opportunity, contract_date
                FROM ticketsmodule_stat_deals WHERE company_id IS NOT NULL`),
    pool.query('SELECT company_id, group_name, bdm_bitrix_id FROM ticketsmodule_project_clients'),
    pool.query('SELECT id, company_id, name, kind FROM ticketsmodule_kam_units'),
    loadAssignments(),
  ]);
  const pcByCo = {}; pcs.forEach(p => { pcByCo[String(p.company_id)] = p; });

  // Компания → её группа (из project_clients.group_name, иначе mode(group_ref))
  const groupRefByCo = {}; // company_id → наиболее частый group_ref
  const refCount = {};
  deals.forEach(d => {
    if (!d.group_ref) return;
    const k = String(d.company_id); refCount[k] = refCount[k] || {};
    refCount[k][d.group_ref] = (refCount[k][d.group_ref] || 0) + 1;
  });
  Object.keys(refCount).forEach(k => {
    groupRefByCo[k] = Object.entries(refCount[k]).sort((a, b) => b[1] - a[1])[0][0];
  });

  // Резолвим имена групп
  const coGroup = {}; // company_id → {name, ref}
  for (const d of deals) {
    const cid = String(d.company_id);
    if (coGroup[cid]) continue;
    const pc = pcByCo[cid];
    const ref = groupRefByCo[cid] || null;
    const name = await groupNameOf(ref, pc && pc.group_name);
    coGroup[cid] = { name: name || 'Без группы', ref };
  }

  return { deals, pcByCo, units, assign, coGroup };
}

// Эффективный КАМ (с наследованием)
function effKam(assign, { groupKey, companyId, unitId }) {
  if (unitId != null && assign.unit[String(unitId)] != null) return { bid: assign.unit[String(unitId)], level: 'unit' };
  if (companyId != null && assign.company[String(companyId)] != null) return { bid: assign.company[String(companyId)], level: 'company', inherited: unitId != null };
  if (groupKey != null && assign.group[groupKey] != null) return { bid: assign.group[groupKey], level: 'group', inherited: companyId != null || unitId != null };
  return { bid: null, level: null };
}

function dealStats(ds) {
  let sum = 0, pre = 0, post = 0;
  ds.forEach(d => { sum += Number(d.opportunity) || 0; if (d.contract_date) post++; else pre++; });
  return { count: ds.length, sum, pre, post };
}

// ── Дерево: Группы → Компании → Подразделения (+ прямые проекты) ─────────────
async function getTree() {
  const { deals, units, assign, coGroup } = await loadModel();
  // company_id → {name, group, deals[]}
  const coMap = {};
  deals.forEach(d => {
    const cid = String(d.company_id);
    if (!coMap[cid]) coMap[cid] = { id: cid, name: d.company_name || ('Компания #' + cid), group: coGroup[cid] || { name: 'Без группы' }, deals: [] };
    coMap[cid].deals.push(d);
  });
  // реестр подразделений по компании
  const unitsByCo = {}; units.forEach(u => { (unitsByCo[String(u.company_id)] = unitsByCo[String(u.company_id)] || []).push(u); });

  // Группируем по группам
  const groups = {};
  Object.values(coMap).forEach(co => {
    const gk = co.group.name;
    if (!groups[gk]) groups[gk] = { key: gk, name: gk, companies: [] };
    // подразделения компании: из unit_tag сделок + реестра
    const unitNames = new Set();
    co.deals.forEach(d => { if (d.unit_tag) unitNames.add(d.unit_tag); });
    (unitsByCo[co.id] || []).forEach(u => unitNames.add(u.name));
    const labs = [...unitNames].map(nm => {
      const reg = (unitsByCo[co.id] || []).find(u => u.name === nm);
      const ds = co.deals.filter(d => d.unit_tag === nm);
      const ek = effKam(assign, { groupKey: gk, companyId: co.id, unitId: reg ? reg.id : null });
      return { id: reg ? reg.id : null, name: nm, kind: reg ? reg.kind : 'lab', kam: ek.bid, kamName: uname(ek.bid), inherited: !!ek.inherited || ek.level !== 'unit', ...dealStats(ds) };
    });
    const directDeals = co.deals.filter(d => !d.unit_tag);
    const ekCo = effKam(assign, { groupKey: gk, companyId: co.id });
    groups[gk].companies.push({
      id: co.id, name: co.name, kam: ekCo.bid, kamName: uname(ekCo.bid), inherited: !!ekCo.inherited,
      labs, directDeals: dealStats(directDeals), ...dealStats(co.deals),
    });
  });
  // КАМ группы + агрегаты
  const out = Object.values(groups).map(g => {
    const ekG = effKam(assign, { groupKey: g.key });
    const allDeals = g.companies.reduce((a, c) => a + c.count, 0);
    const sum = g.companies.reduce((a, c) => a + c.sum, 0);
    return { ...g, kam: ekG.bid, kamName: uname(ekG.bid), companiesCount: g.companies.length, dealsCount: allDeals, sumMln: mln(sum) };
  }).sort((a, b) => b.dealsCount - a.dealsCount);
  return { groups: out };
}

// Проекты узла (группа/компания/подразделение)
function projectsOf(deals) {
  const by = {};
  deals.forEach(d => { const p = d.project_tag || '— вне проекта —'; (by[p] = by[p] || []).push(d); });
  return Object.entries(by).map(([name, ds]) => ({ name, ...dealStats(ds), sumMln: mln(dealStats(ds).sum) }))
    .sort((a, b) => b.sum - a.sum);
}

// Карточка узла
async function getNode(type, key) {
  const { deals, units, assign, coGroup } = await loadModel();
  let subset = [], title = key, group = null, companyId = null, unitId = null, nl = 0, nc = 0;
  if (type === 'group') {
    subset = deals.filter(d => (coGroup[String(d.company_id)] || {}).name === key);
    const cos = new Set(subset.map(d => String(d.company_id))); nc = cos.size;
    const us = new Set(subset.filter(d => d.unit_tag).map(d => String(d.company_id) + '|' + d.unit_tag)); nl = us.size;
    group = key;
  } else if (type === 'company') {
    subset = deals.filter(d => String(d.company_id) === String(key));
    title = (subset[0] && subset[0].company_name) || ('Компания #' + key);
    companyId = String(key); nc = 1; group = (coGroup[String(key)] || {}).name;
    nl = new Set(subset.filter(d => d.unit_tag).map(d => d.unit_tag)).size;
  } else if (type === 'unit') {
    // key = "companyId|unitName"
    const [cid, ...rest] = String(key).split('|'); const un = rest.join('|');
    subset = deals.filter(d => String(d.company_id) === cid && d.unit_tag === un);
    title = un; companyId = cid; nc = 1; nl = 1; group = (coGroup[cid] || {}).name;
    const reg = units.find(u => String(u.company_id) === cid && u.name === un); unitId = reg ? reg.id : null;
  }
  const ek = effKam(assign, { groupKey: group, companyId, unitId });
  const st = dealStats(subset);
  return {
    type, key, title, group,
    kam: ek.bid, kamName: uname(ek.bid), kamLevel: ek.level, inherited: !!ek.inherited,
    companies: nc, units: nl, projects: projectsOf(subset).length,
    deals: st.count, pre: st.pre, post: st.post, sumMln: mln(st.sum),
    projectsList: projectsOf(subset),
  };
}

// Портфель КАМ
async function getKamPortfolio(bid) {
  const { deals, units, assign, coGroup } = await loadModel();
  bid = Number(bid);
  const coMap = {};
  deals.forEach(d => { const cid = String(d.company_id); (coMap[cid] = coMap[cid] || []).push(d); });
  const unitsByCo = {}; units.forEach(u => { (unitsByCo[String(u.company_id)] = unitsByCo[String(u.company_id)] || []).push(u); });
  const rows = [];
  Object.entries(coMap).forEach(([cid, ds]) => {
    const g = (coGroup[cid] || {}).name;
    const unitNames = new Set(); ds.forEach(d => { if (d.unit_tag) unitNames.add(d.unit_tag); });
    (unitsByCo[cid] || []).forEach(u => unitNames.add(u.name));
    const labs = [...unitNames].filter(nm => {
      const reg = (unitsByCo[cid] || []).find(u => u.name === nm);
      return effKam(assign, { groupKey: g, companyId: cid, unitId: reg ? reg.id : null }).bid === bid;
    }).map(nm => {
      const reg = (unitsByCo[cid] || []).find(u => u.name === nm);
      const own = effKam(assign, { groupKey: g, companyId: cid, unitId: reg ? reg.id : null }).level === 'unit';
      return { name: nm, own, projects: projectsOf(ds.filter(d => d.unit_tag === nm)).length };
    });
    const directOwner = unitNames.size === 0 && effKam(assign, { groupKey: g, companyId: cid }).bid === bid;
    if (labs.length || directOwner) {
      rows.push({ companyId: cid, company: ds[0].company_name, group: g, direct: directOwner, labs,
        projects: projectsOf(ds).length });
    }
  });
  const flatDeals = [];
  rows.forEach(r => { (coMap[r.companyId] || []).forEach(d => flatDeals.push(d)); });
  const st = dealStats(flatDeals);
  return { bid, name: uname(bid), companies: rows.length, sumMln: mln(st.sum), deals: st.count, rows };
}

// Подразделения компании (для зависимого дропдауна): реестр + значения из сделок
async function listUnits(companyId) {
  const [{ rows: reg }, { rows: used }] = await Promise.all([
    pool.query('SELECT id, name, kind FROM ticketsmodule_kam_units WHERE company_id=$1 ORDER BY name', [String(companyId)]),
    pool.query("SELECT DISTINCT unit_tag FROM ticketsmodule_stat_deals WHERE company_id=$1 AND unit_tag IS NOT NULL AND unit_tag<>''", [String(companyId)]),
  ]);
  const names = new Set(reg.map(r => r.name));
  const extra = used.map(u => u.unit_tag).filter(n => !names.has(n)).map(n => ({ id: null, name: n, kind: 'lab', fromDeals: true }));
  return { units: [...reg, ...extra] };
}

module.exports = { getTree, getNode, getKamPortfolio, listUnits, resolveGroupMap, uname };

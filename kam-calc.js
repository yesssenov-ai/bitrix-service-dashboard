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
const { bust } = require('./cache');
const UNIT_FIELD = 'UF_CRM_1731862825010'; // текстовое поле подразделения на сделке
const PROJECT_FIELD = 'UF_CRM_1791972186';  // enum «В рамках проекта» (множественное)
const NO_PROJECT_RE = /^без\s*проект/i;      // «Без проекта» → не считаем проектом

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
// scope: { full:bool, userBid:number } — непривилегированный КАМ видит только узлы,
// где он эффективный КАМ (компания/подразделение/группа). Не назначен → пусто.
async function getTree(scope) {
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
    const ekCoEff = effKam(assign, { groupKey: gk, companyId: co.id });   // эфф. КАМ компании (для наследования подразделению)
    const grpKamName = uname(effKam(assign, { groupKey: gk }).bid);        // КАМ группы (наследование компании)
    const labs = [...unitNames].map(nm => {
      const reg = (unitsByCo[co.id] || []).find(u => u.name === nm);
      const ds = co.deals.filter(d => d.unit_tag === nm);
      const ek = effKam(assign, { groupKey: gk, companyId: co.id, unitId: reg ? reg.id : null });
      return {
        id: reg ? reg.id : null, name: nm, kind: reg ? reg.kind : 'lab',
        kam: ek.bid, kamName: uname(ek.bid), inherited: !!ek.inherited || ek.level !== 'unit',
        ownKam: reg ? (assign.unit[String(reg.id)] != null ? assign.unit[String(reg.id)] : null) : null,
        inheritName: uname(ekCoEff.bid),
        ...dealStats(ds),
      };
    });
    const directDeals = co.deals.filter(d => !d.unit_tag);
    groups[gk].companies.push({
      id: co.id, name: co.name, kam: ekCoEff.bid, kamName: uname(ekCoEff.bid), inherited: !!ekCoEff.inherited,
      ownKam: assign.company[String(co.id)] != null ? assign.company[String(co.id)] : null,
      inheritName: grpKamName,
      labs, directDeals: dealStats(directDeals), ...dealStats(co.deals),
    });
  });
  // КАМ группы + агрегаты
  let out = Object.values(groups).map(g => {
    const ekG = effKam(assign, { groupKey: g.key });
    const allDeals = g.companies.reduce((a, c) => a + c.count, 0);
    const sum = g.companies.reduce((a, c) => a + c.sum, 0);
    return { ...g, kam: ekG.bid, kamName: uname(ekG.bid), companiesCount: g.companies.length, dealsCount: allDeals, sumMln: mln(sum) };
  }).sort((a, b) => b.dealsCount - a.dealsCount);
  // Скоуп по КАМ: показать только свои узлы (если не админ/координатор)
  const scoped = !!(scope && !scope.full);
  if (scoped && scope.userBid != null) {
    const uid = Number(scope.userBid);
    out = out.map(g => {
      if (g.kam === uid) return g; // владеет всей группой
      const comps = (g.companies || []).filter(c => c.kam === uid || (c.labs || []).some(l => l.kam === uid));
      if (!comps.length) return null;
      const dc = comps.reduce((a, c) => a + c.count, 0), sm = comps.reduce((a, c) => a + c.sum, 0);
      return { ...g, companies: comps, companiesCount: comps.length, dealsCount: dc, sumMln: mln(sm) };
    }).filter(Boolean);
  }
  return { groups: out, scoped };
}

// ── Дерево «От проектов»: Проект → Компании (с эфф. КАМ) → сделки ─────────────
// Верхний уровень — проект (project_tag). Внутри — компании, у которых есть сделки
// по этому проекту, с их эффективным КАМ. Клик по компании раскрывает сделки
// (frontend зовёт /deals?type=company&key=<cid>&project=<proj>).
// scope: непривилегированный КАМ видит только проекты со своими компаниями.
async function getProjectTree(scope) {
  const { deals, units, assign, coGroup } = await loadModel();
  const unitsByCo = {}; units.forEach(u => { (unitsByCo[String(u.company_id)] = unitsByCo[String(u.company_id)] || []).push(u); });
  const uid = scope && !scope.full && scope.userBid != null ? Number(scope.userBid) : null;

  // Множество эфф. КАМ компании (сам уровень компании + её подразделения) — для скоупа.
  const ownsCompany = (gk, cid, kuid) => {
    if (effKam(assign, { groupKey: gk, companyId: cid }).bid === kuid) return true;
    return (unitsByCo[cid] || []).some(u => effKam(assign, { groupKey: gk, companyId: cid, unitId: u.id }).bid === kuid);
  };

  // project_tag → company_id → {deals[]}
  const projMap = {};
  deals.forEach(d => {
    const p = d.project_tag || '— вне проекта —';
    const cid = String(d.company_id);
    const pm = (projMap[p] = projMap[p] || {});
    (pm[cid] = pm[cid] || { id: cid, name: d.company_name || ('Компания #' + cid), deals: [] }).deals.push(d);
  });

  let out = Object.entries(projMap).map(([pname, comps]) => {
    let companies = Object.values(comps).map(co => {
      const gk = (coGroup[co.id] || {}).name;
      const ek = effKam(assign, { groupKey: gk, companyId: co.id });
      const st = dealStats(co.deals);
      return { id: co.id, name: co.name, group: gk, kam: ek.bid, kamName: uname(ek.bid), inherited: !!ek.inherited, ...st, sumMln: mln(st.sum) };
    });
    if (uid != null) companies = companies.filter(c => ownsCompany(c.group, c.id, uid));
    companies.sort((a, b) => b.sum - a.sum);
    const dc = companies.reduce((a, c) => a + c.count, 0), sm = companies.reduce((a, c) => a + c.sum, 0);
    return { name: pname, companies, companiesCount: companies.length, dealsCount: dc, sumMln: mln(sm), sum: sm };
  }).filter(p => p.companies.length).sort((a, b) => b.sum - a.sum);

  return { projects: out, scoped: uid != null };
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

// Сделки узла (для раскрытия карточки проекта). project — фильтр по проекту.
async function nodeDeals(type, key, project) {
  const { deals, coGroup } = await loadModel();
  let subset = [];
  if (type === 'group') subset = deals.filter(d => (coGroup[String(d.company_id)] || {}).name === key);
  else if (type === 'company') subset = deals.filter(d => String(d.company_id) === String(key));
  else if (type === 'unit') { const [cid, ...r] = String(key).split('|'); const un = r.join('|'); subset = deals.filter(d => String(d.company_id) === cid && d.unit_tag === un); }
  if (project) subset = subset.filter(d => (d.project_tag || '— вне проекта —') === project);
  subset.sort((a, b) => (Number(b.opportunity) || 0) - (Number(a.opportunity) || 0));
  return {
    deals: subset.slice(0, 300).map(d => ({
      dealId: d.deal_id, title: d.deal_title || ('Сделка #' + d.deal_id), unit: d.unit_tag || '',
      companyId: String(d.company_id), company: d.company_name || '', sumMln: mln(d.opportunity),
      post: !!d.contract_date, stage: d.stage_id, project: d.project_tag || '',
      url: 'https://crm.prolabsupport.kz/crm/deal/details/' + d.deal_id + '/',
    })),
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

// ── WRITE (админка) ──────────────────────────────────────────────────────────
// Назначить/снять КАМ на узле. level: group|company|unit; key: имя группы /
// company_id / unit id. КАМ хранится только в ЦУП (поля на сделке в Б24 нет).
async function assignKam(level, key, bid, by) {
  if (!['group', 'company', 'unit'].includes(level)) throw new Error('bad level');
  if (bid === null || bid === '' || bid === undefined) {
    await pool.query('DELETE FROM ticketsmodule_kam_assign WHERE level=$1 AND node_key=$2', [level, String(key)]);
  } else {
    await pool.query(
      `INSERT INTO ticketsmodule_kam_assign (level, node_key, kam_bitrix_id, updated_at, updated_by)
       VALUES ($1,$2,$3,NOW(),$4)
       ON CONFLICT (level, node_key) DO UPDATE SET kam_bitrix_id=$3, updated_at=NOW(), updated_by=$4`,
      [level, String(key), parseInt(bid, 10), by || null]);
  }
  bust('kam:');
  return { ok: true };
}

// Реестр подразделений (отдел/лаборатория/факультет) per компания.
async function createUnit(companyId, name, kind, by) {
  name = String(name || '').trim();
  if (!companyId) throw new Error('no company');
  if (!name) throw new Error('empty name');
  const { rows } = await pool.query(
    `INSERT INTO ticketsmodule_kam_units (company_id, name, kind, bitrix_value, created_by)
     VALUES ($1,$2,$3,$2,$4)
     ON CONFLICT (company_id, name) DO UPDATE SET kind=$3 RETURNING id`,
    [String(companyId), name, kind || 'lab', by || null]);
  bust('kam:');
  return { ok: true, id: rows[0] && rows[0].id };
}
async function deleteUnit(id) {
  await pool.query('DELETE FROM ticketsmodule_kam_units WHERE id=$1', [parseInt(id, 10)]);
  bust('kam:');
  return { ok: true };
}

// name → id элемента справочника «Группа компаний» (обратная карта)
async function reverseGroupMap() {
  const map = await resolveGroupMap();
  const rev = {};
  Object.entries(map).forEach(([id, name]) => { if (name) rev[String(name).trim()] = id; });
  return rev;
}

// Пакетная запись одного поля сделкам (Bitrix batch, до 50 за вызов).
async function batchUpdateDeals(dealIds, fieldCode, value) {
  let written = 0;
  for (let i = 0; i < dealIds.length; i += 50) {
    const chunk = dealIds.slice(i, i + 50);
    const cmd = {};
    chunk.forEach((id, k) => { cmd['u' + k] = `crm.deal.update?id=${id}&fields[${fieldCode}]=${encodeURIComponent(value)}`; });
    try { await b24('batch', { halt: 0, cmd }); written += chunk.length; }
    catch (e) { console.error('kam batchUpdateDeals:', e.message); }
  }
  return written;
}

// Перенести компанию в группу. ЦУП-авторитетно (project_clients.group_name → дерево
// перегруппируется сразу) + зеркалим group_ref в Б24 на сделки компании.
async function moveCompanyGroup(companyId, companyName, group, by) {
  companyId = String(companyId);
  group = String(group || '').trim() || null;
  await pool.query(
    `INSERT INTO ticketsmodule_project_clients (company_id, company_name, group_name, updated_at, updated_by)
     VALUES ($1,$2,$3,NOW(),$4)
     ON CONFLICT (company_id) DO UPDATE SET group_name=$3,
       company_name=COALESCE(EXCLUDED.company_name, ticketsmodule_project_clients.company_name),
       updated_at=NOW(), updated_by=$4`,
    [companyId, companyName || null, group, by || null]);
  // Зеркалирование в Б24: id элемента справочника для группы (пусто → очистка поля)
  let groupId = '';
  if (group) { const rev = await reverseGroupMap(); groupId = rev[group] || ''; }
  const { rows } = await pool.query('SELECT deal_id FROM ticketsmodule_stat_deals WHERE company_id=$1', [companyId]);
  const dealIds = rows.map(r => r.deal_id);
  let mirrored = 0, mirrorNote = null;
  if (group && !groupId) { mirrorNote = 'группы «' + group + '» нет в справочнике Б24 — записана только в ЦУП'; }
  else if (dealIds.length) {
    mirrored = await batchUpdateDeals(dealIds, 'UF_CRM_1731862481', groupId);
    await pool.query('UPDATE ticketsmodule_stat_deals SET group_ref=$1 WHERE company_id=$2', [groupId || null, companyId]);
  }
  bust('kam:');
  return { ok: true, group, mirrored, deals: dealIds.length, mirrorNote };
}

// Сделки узла (для назначения подразделения прямо на сделке).
async function listDeals(companyId, unit) {
  const params = [String(companyId)];
  let where = 'company_id=$1';
  if (unit === '__none__') where += " AND (unit_tag IS NULL OR unit_tag='')";
  else if (unit) { where += ' AND unit_tag=$2'; params.push(unit); }
  const { rows } = await pool.query(
    `SELECT deal_id, deal_title, unit_tag, stage_id, category_id, opportunity, contract_date, project_tag
       FROM ticketsmodule_stat_deals WHERE ${where} ORDER BY date_create DESC NULLS LAST LIMIT 300`, params);
  return {
    deals: rows.map(r => ({
      dealId: r.deal_id, title: r.deal_title || ('Сделка #' + r.deal_id), unit: r.unit_tag || '',
      project: r.project_tag || '', stage: r.stage_id, sumMln: mln(r.opportunity),
      post: !!r.contract_date, url: 'https://crm.prolabsupport.kz/crm/deal/details/' + r.deal_id + '/',
    })),
  };
}

// Проставить подразделение конкретной сделке → пишем в Б24 (текстовое поле) + зеркало.
async function setDealUnit(dealId, unit, by) {
  dealId = parseInt(dealId, 10);
  unit = String(unit == null ? '' : unit).trim();
  await b24('crm.deal.update', { id: dealId, fields: { [UNIT_FIELD]: unit } });
  await pool.query('UPDATE ticketsmodule_stat_deals SET unit_tag=$1 WHERE deal_id=$2', [unit || null, dealId]);
  bust('kam:');
  return { ok: true };
}

// Опции проекта (enum «В рамках проекта») для назначения сделке. Кэш 6ч.
let projOptCache = null, projOptAt = 0;
async function listProjectOptions() {
  if (projOptCache && Date.now() - projOptAt < 6 * 3600 * 1000) return projOptCache;
  try {
    const { result } = await b24('crm.deal.userfield.list', { filter: { FIELD_NAME: PROJECT_FIELD } });
    const f = (result || [])[0];
    const opts = ((f && f.LIST) || []).map(it => ({ id: String(it.ID), value: it.VALUE }))
      .filter(o => o.value && !NO_PROJECT_RE.test(String(o.value).trim()))
      .sort((a, b) => a.value.localeCompare(b.value, 'ru'));
    projOptCache = opts; projOptAt = Date.now();
    return opts;
  } catch (e) { return projOptCache || []; }
}

// Присвоить сделке проект → пишем enum в Б24 (множественное поле) + зеркало project_tag.
async function setDealProject(dealId, projectId, by) {
  dealId = parseInt(dealId, 10);
  projectId = String(projectId == null ? '' : projectId).trim();
  let value = null;
  if (projectId) { const opts = await listProjectOptions(); const o = opts.find(x => x.id === projectId); value = o ? o.value : null; }
  await b24('crm.deal.update', { id: dealId, fields: { [PROJECT_FIELD]: projectId ? [projectId] : '' } });
  await pool.query('UPDATE ticketsmodule_stat_deals SET project_tag=$1 WHERE deal_id=$2', [value, dealId]);
  bust('kam:');
  return { ok: true, project: value };
}

async function listUsers() {
  return Object.entries(USERS).filter(([id]) => id !== '1')
    .map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
async function listGroups() {
  const { rows } = await pool.query("SELECT DISTINCT group_name FROM ticketsmodule_project_clients WHERE group_name IS NOT NULL AND group_name<>''");
  const names = new Set(rows.map(r => r.group_name));
  try { const map = await resolveGroupMap(); Object.values(map).forEach(n => names.add(n)); } catch (e) {}
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'));
}

module.exports = {
  getTree, getProjectTree, getNode, getKamPortfolio, listUnits, resolveGroupMap, uname,
  assignKam, createUnit, deleteUnit, moveCompanyGroup, setDealUnit, setDealProject, listProjectOptions, listUsers, listGroups, listDeals, nodeDeals,
};

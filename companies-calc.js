// Модуль «Компании / Оздоровление» (Фаза 1): единый реестр компаний Б24 в ЦУП
// с инлайн-правкой сферы деятельности (INDUSTRY) и названия — запись обратно в Б24.
// Детектор дублей и слияние — отдельные фазы (см. claude/company-healing-design.md).
// Зеркало в Postgres — только кэш для скорости; правда — в Bitrix, ЦУП синхронит.
const { pool } = require('./auth');
const { b24 } = require('./bitrix');
const { USERS } = require('./constants');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const uname = id => id ? (USERS[id] || ('#' + id)) : '';

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_companies (
        id VARCHAR(40) PRIMARY KEY,
        title VARCHAR(500),
        industry_id VARCHAR(60),
        industry_name VARCHAR(200),
        bin VARCHAR(40),
        email VARCHAR(300),
        phone VARCHAR(100),
        assigned_bid INTEGER,
        city VARCHAR(160),
        created_at TIMESTAMPTZ,
        deal_count INTEGER DEFAULT 0,
        synced_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_cmp_industry ON ticketsmodule_companies(industry_id);
      CREATE INDEX IF NOT EXISTS idx_cmp_assigned ON ticketsmodule_companies(assigned_bid);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Справочник сфер (INDUSTRY): id → name, и список для выпадающего списка ──────
let _indMap = null, _indAt = 0;
async function industryMap() {
  if (_indMap && Date.now() - _indAt < 6 * 3600 * 1000) return _indMap;
  const map = {};
  try {
    const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: 'INDUSTRY' }, order: { SORT: 'ASC' } });
    (result || []).forEach(s => { map[s.STATUS_ID] = s.NAME; });
  } catch (e) { console.error('companies industryMap:', e.message); }
  _indMap = map; _indAt = Date.now();
  return map;
}
async function industryOptions() {
  const m = await industryMap();
  return Object.entries(m).map(([id, name]) => ({ id, name }));
}

// ── Поле БИН у компании (кастомное): имя поля определяем динамически (кэш) ──────
let _binCode = null, _binAt = 0;
async function binFieldCode() {
  const env = process.env.CMP_BIN_FIELD;
  if (env) return env;
  if (_binCode !== null && Date.now() - _binAt < 6 * 3600 * 1000) return _binCode;
  let code = '';
  try {
    const { result } = await b24('crm.company.fields', {});
    for (const [k, f] of Object.entries(result || {})) {
      const title = String((f && (f.title || f.formLabel || f.listLabel)) || '').toLowerCase();
      if (/\bбин\b|\bиин\b|\bбин\/иин\b|\biin\b|\bbin\b/.test(title)) { code = k; break; }
    }
  } catch (e) { console.error('companies binFieldCode:', e.message); }
  _binCode = code; _binAt = Date.now();
  return code;
}

// Первое значение мультиполя (EMAIL/PHONE: [{VALUE}]) либо кастомного поля (массив/скаляр).
function firstMf(mf) {
  if (!mf) return '';
  const arr = Array.isArray(mf) ? mf : [mf];
  const v = arr.map(x => (x && typeof x === 'object') ? x.VALUE : x).filter(Boolean)[0];
  return v ? String(v).trim() : '';
}
function firstVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(x => x != null && x !== '').map(String)[0] || '';
  return String(v).trim();
}

// ── Синхронизация всех компаний из Bitrix в зеркало ────────────────────────────
let _syncing = false;
async function syncCompanies() {
  if (_syncing) return { skipped: 'running' };
  _syncing = true;
  try {
    await ensureSchema();
    const inds = await industryMap();
    const binCode = await binFieldCode();
    // число сделок на компанию — из зеркала сделок статистики.
    const dc = {};
    try {
      const r = await pool.query("SELECT company_id, COUNT(*)::int AS n FROM ticketsmodule_stat_deals WHERE company_id IS NOT NULL GROUP BY company_id");
      r.rows.forEach(x => { dc[String(x.company_id)] = x.n; });
    } catch (e) { /* зеркала сделок может не быть — не критично */ }

    const select = ['ID', 'TITLE', 'INDUSTRY', 'ASSIGNED_BY_ID', 'DATE_CREATE', 'ADDRESS_CITY', 'EMAIL', 'PHONE'];
    if (binCode) select.push(binCode);
    const rows = [];
    let start = 0, guard = 0;
    while (guard++ < 5000) {
      const res = await b24('crm.company.list', { select, order: { ID: 'ASC' }, start });
      const arr = res.result || [];
      for (const c of arr) {
        const industryId = c.INDUSTRY || '';
        rows.push({
          id: String(c.ID), title: c.TITLE || '',
          industryId, industryName: inds[industryId] || '',
          bin: binCode ? firstVal(c[binCode]) : '',
          email: firstMf(c.EMAIL), phone: firstMf(c.PHONE),
          assignedBid: c.ASSIGNED_BY_ID ? Number(c.ASSIGNED_BY_ID) : null,
          city: c.ADDRESS_CITY || '',
          createdAt: c.DATE_CREATE || null,
          dealCount: dc[String(c.ID)] || 0,
        });
      }
      if (res.next == null) break;
      start = res.next; await sleep(100);
    }

    await pool.query('DELETE FROM ticketsmodule_companies');
    // пакетная вставка
    const CH = 500;
    for (let i = 0; i < rows.length; i += CH) {
      const batch = rows.slice(i, i + CH);
      const vals = [], ph = [];
      batch.forEach((r, j) => {
        const b = j * 11;
        ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`);
        vals.push(r.id, r.title || '', r.industryId || '', r.industryName || '', r.bin || '', r.email || '', r.phone || '',
          r.assignedBid || null, r.city || '', r.createdAt || null, r.dealCount || 0);
      });
      await pool.query(
        `INSERT INTO ticketsmodule_companies (id,title,industry_id,industry_name,bin,email,phone,assigned_bid,city,created_at,deal_count)
         VALUES ${ph.join(',')} ON CONFLICT (id) DO UPDATE SET
           title=EXCLUDED.title,industry_id=EXCLUDED.industry_id,industry_name=EXCLUDED.industry_name,bin=EXCLUDED.bin,
           email=EXCLUDED.email,phone=EXCLUDED.phone,assigned_bid=EXCLUDED.assigned_bid,city=EXCLUDED.city,
           created_at=EXCLUDED.created_at,deal_count=EXCLUDED.deal_count,synced_at=NOW()`, vals);
    }
    return { ok: true, count: rows.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally { _syncing = false; }
}

// Нормализованное имя — для детектора «возможных дублей».
// ВАЖНО: организационные формы (ТОО/ООО/…) вырезаем ПОТОКЕННО, а не через \b —
// в JS \b не распознаёт кириллицу (\w = [A-Za-z0-9_]), поэтому \bтоо\b по-русски
// не срабатывает. Поэтому сначала чистим пунктуацию до пробелов, потом фильтруем слова.
const ORG_FORMS = new Set(['тоо', 'ооо', 'оао', 'зао', 'ао', 'ип', 'тов', 'llp', 'llc', 'ltd',
  'inc', 'gmbh', 'ргп', 'гу', 'кгп', 'нао', 'ксхп', 'пхв', 'на', 'ркп', 'чк', 'фк', 'кх', 'тоо']);
function normName(s) {
  return String(s || '').toLowerCase().replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim().split(/\s+/)
    .filter(w => w && !ORG_FORMS.has(w))
    .join(' ');
}
function problemsOf(r, dupNames) {
  const p = [];
  if (!r.industry_id) p.push('без сферы');
  if (!r.bin) p.push('без БИН');
  const t = String(r.title || '').trim();
  if (t.length < 3) p.push('короткое имя');
  if (/(^|\s)(тест|test|проверка|asdf|ыва)(\s|$)/i.test(t)) p.push('похоже на тест');
  if (t && dupNames.has(normName(t))) p.push('возможный дубль');
  return p;
}

async function getCompaniesBoard() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_companies ORDER BY title');
  if (!rows.length) { await syncCompanies(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_companies ORDER BY title')); }
  // множество нормализованных имён, встречающихся >1 раза → «возможный дубль»
  const cnt = {};
  for (const r of rows) { const n = normName(r.title); if (n) cnt[n] = (cnt[n] || 0) + 1; }
  const dupNames = new Set(Object.entries(cnt).filter(([, n]) => n > 1).map(([k]) => k));

  const inds = await industryMap();
  const asOf = rows.length ? rows.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), rows[0].synced_at) : null;
  const out = rows.map(r => {
    const problems = problemsOf(r, dupNames);
    return {
      id: r.id, title: r.title, industryId: r.industry_id || '', industryName: r.industry_name || (r.industry_id ? (inds[r.industry_id] || r.industry_id) : ''),
      bin: r.bin || '', email: r.email || '', phone: r.phone || '',
      owner: uname(r.assigned_bid), city: r.city || '', createdAt: r.created_at,
      dealCount: Number(r.deal_count || 0), problems,
    };
  });
  const uniq = f => [...new Set(out.map(x => x[f]).filter(Boolean))].sort();
  return {
    rows: out,
    industries: Object.entries(inds).map(([id, name]) => ({ id, name })),
    filters: { industries: uniq('industryName'), owners: uniq('owner'), cities: uniq('city') },
    summary: {
      total: out.length,
      noIndustry: out.filter(r => !r.industryId).length,
      noBin: out.filter(r => !r.bin).length,
      dup: out.filter(r => r.problems.includes('возможный дубль')).length,
    },
    asOf,
  };
}

// ── Правка компании (сфера / название) с записью в Б24 ─────────────────────────
async function updateCompany(id, { industryId, title }) {
  await ensureSchema();
  id = String(id);
  const fields = {};
  if (industryId !== undefined) fields.INDUSTRY = industryId || ''; // '' — очистить сферу
  if (title !== undefined && String(title).trim() !== '') fields.TITLE = String(title).trim();
  if (!Object.keys(fields).length) return { ok: false, error: 'Нет изменений' };
  await b24('crm.company.update', { id, fields });
  // Обновляем зеркало
  const inds = await industryMap();
  const set = [], vals = []; let i = 1;
  if (fields.INDUSTRY !== undefined) { set.push(`industry_id=$${i++}`, `industry_name=$${i++}`); vals.push(fields.INDUSTRY || '', inds[fields.INDUSTRY] || ''); }
  if (fields.TITLE !== undefined) { set.push(`title=$${i++}`); vals.push(fields.TITLE); }
  set.push('synced_at=NOW()');
  vals.push(id);
  await pool.query(`UPDATE ticketsmodule_companies SET ${set.join(',')} WHERE id=$${i}`, vals);
  return { ok: true, id, industryId: fields.INDUSTRY, industryName: fields.INDUSTRY !== undefined ? (inds[fields.INDUSTRY] || '') : undefined, title: fields.TITLE };
}

// ── Фаза 2: детектор дублей ────────────────────────────────────────────────────
// Нормализация e-mail и телефона для ключей дедупа.
function normEmail(s) { return String(s || '').trim().toLowerCase(); }
function normPhone(s) {
  let d = String(s || '').replace(/\D+/g, '');
  if (d.length === 11 && (d[0] === '8' || d[0] === '7')) d = d.slice(1); // 8/7XXXXXXXXXX → XXXXXXXXXX
  return d.length >= 10 ? d.slice(-10) : '';
}
function filledCount(r) {
  return ['industry_id', 'bin', 'email', 'phone', 'city'].reduce((n, k) => n + (r[k] ? 1 : 0), 0);
}

// Кластеризация компаний в группы-кандидаты на дубль по сильным ключам:
// БИН (точное совпадение — самый надёжный), нормализованное название, e-mail, телефон.
// Слишком частые e-mail/телефон (общая приёмная/инфо-адрес) исключаем, чтобы не
// склеивать десятки разных компаний в один ложный кластер. Только обнаружение —
// слияние и запись в Б24 будут в Фазе 3.
async function getDuplicateGroups() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_companies ORDER BY id');
  if (!rows.length) { await syncCompanies(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_companies ORDER BY id')); }
  const inds = await industryMap();

  const n = rows.length;
  const key = { bin: [], name: [], email: [], phone: [] };
  const freqEmail = {}, freqPhone = {};
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    key.bin[i] = String(r.bin || '').replace(/\D+/g, '');
    const nm = normName(r.title); key.name[i] = nm.length >= 3 ? nm : '';
    key.email[i] = normEmail(r.email);
    key.phone[i] = normPhone(r.phone);
    if (key.email[i]) freqEmail[key.email[i]] = (freqEmail[key.email[i]] || 0) + 1;
    if (key.phone[i]) freqPhone[key.phone[i]] = (freqPhone[key.phone[i]] || 0) + 1;
  }
  // «Шумные» контакты — встречаются у >4 компаний → не используем для склейки.
  const NOISE = 4;
  for (let i = 0; i < n; i++) {
    if (key.email[i] && freqEmail[key.email[i]] > NOISE) key.email[i] = '';
    if (key.phone[i] && freqPhone[key.phone[i]] > NOISE) key.phone[i] = '';
  }

  // Union-Find по индексам
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const field of ['bin', 'name', 'email', 'phone']) {
    const buckets = {};
    for (let i = 0; i < n; i++) { const v = key[field][i]; if (v) (buckets[v] || (buckets[v] = [])).push(i); }
    for (const ids of Object.values(buckets)) for (let j = 1; j < ids.length; j++) union(ids[0], ids[j]);
  }

  // Собираем кластеры размером ≥2
  const clusters = {};
  for (let i = 0; i < n; i++) { const root = find(i); (clusters[root] || (clusters[root] = [])).push(i); }
  const reasonLabel = { bin: 'БИН', name: 'название', email: 'e-mail', phone: 'телефон' };
  const groups = [];
  for (const idxs of Object.values(clusters)) {
    if (idxs.length < 2) continue;
    // какие ключи реально сшили группу (значение встречается у 2+ членов)
    const reasons = [];
    for (const field of ['bin', 'name', 'email', 'phone']) {
      const c = {}; let shared = false;
      for (const i of idxs) { const v = key[field][i]; if (!v) continue; if (c[v]) { shared = true; break; } c[v] = 1; }
      if (shared) reasons.push(reasonLabel[field]);
    }
    const members = idxs.map(i => {
      const r = rows[i];
      return {
        id: r.id, title: r.title || '', industryId: r.industry_id || '',
        industryName: r.industry_name || (r.industry_id ? (inds[r.industry_id] || r.industry_id) : ''),
        bin: r.bin || '', email: r.email || '', phone: r.phone || '',
        owner: uname(r.assigned_bid), city: r.city || '', createdAt: r.created_at,
        dealCount: Number(r.deal_count || 0), _filled: filledCount(r),
      };
    });
    // эталон: больше всего сделок → больше заполненных полей → старше (раньше создан) → меньший ID
    members.sort((a, b) => b.dealCount - a.dealCount || b._filled - a._filled
      || (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)) || (Number(a.id) - Number(b.id)));
    const canonicalId = members[0].id;
    members.forEach(m => { m.isCanonical = m.id === canonicalId; delete m._filled; });
    const totalDeals = members.reduce((s, m) => s + m.dealCount, 0);
    const strong = reasons.includes('БИН') ? 3 : reasons.includes('название') ? 2 : 1;
    groups.push({ canonicalId, reasons, size: members.length, totalDeals, members, _strong: strong });
  }
  // сортировка: сильный ключ (БИН) первыми, крупные группы выше, больше сделок выше
  groups.sort((a, b) => b._strong - a._strong || b.size - a.size || b.totalDeals - a.totalDeals);
  groups.forEach(g => delete g._strong);

  const asOf = rows.length ? rows.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), rows[0].synced_at) : null;
  return {
    groups,
    summary: { groups: groups.length, companies: groups.reduce((s, g) => s + g.size, 0) },
    asOf,
  };
}

module.exports = { ensureSchema, syncCompanies, getCompaniesBoard, updateCompany, industryOptions, getDuplicateGroups };

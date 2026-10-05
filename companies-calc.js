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

// Нормализованное имя — для детектора «возможных дублей» (только чтение, Фаза 1).
function normName(s) {
  return String(s || '').toLowerCase()
    .replace(/[«»"'`“”]/g, '')
    .replace(/\b(тоо|ооо|оао|зао|ао|ип|тов|llp|llc|ltd|inc|gmbh|ргп|гу|кгп|нао|ксхп|пхв|на|ркп|чк|фк|кх)\b/g, ' ')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .replace(/\s+/g, ' ').trim();
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

module.exports = { ensureSchema, syncCompanies, getCompaniesBoard, updateCompany, industryOptions };

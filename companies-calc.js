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
      ALTER TABLE ticketsmodule_companies ADD COLUMN IF NOT EXISTS merged_into VARCHAR(40);
      CREATE TABLE IF NOT EXISTS ticketsmodule_company_merges (
        id SERIAL PRIMARY KEY,
        canonical_id VARCHAR(40),
        canonical_title VARCHAR(500),
        duplicate_id VARCHAR(40),
        prev_title VARCHAR(500),
        moved JSONB,              -- { deals:[], contacts:[], items:{ "1058":[] }, copiedFields:{} }
        by_user VARCHAR(120),
        undone BOOLEAN DEFAULT FALSE,
        undone_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_cmp_merge_dup ON ticketsmodule_company_merges(duplicate_id);
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
    // ВАЖНО: токенами, а не \b — в JS \b не распознаёт кириллицу, поэтому \bбин\b
    // по-русски не срабатывает (отсюда «без БИН» у всех). Бьём заголовок на слова.
    const WANT = ['бин', 'иин', 'bin', 'iin'];
    for (const [k, f] of Object.entries(result || {})) {
      const title = String((f && (f.title || f.formLabel || f.listLabel)) || '').toLowerCase().replace(/ё/g, 'е');
      const toks = title.split(/[^a-zа-я0-9]+/).filter(Boolean);
      if (toks.some(t => WANT.includes(t))) { code = k; break; }
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

// Полный подсчёт сделок по компаниям — все стадии и воронки (crm.deal.list без
// фильтра возвращает и открытые, и завершённые). Берём минимум полей ради скорости.
async function allDealCounts() {
  const dc = {};
  let start = 0, guard = 0;
  while (guard++ < 20000) {
    const res = await b24('crm.deal.list', { select: ['ID', 'COMPANY_ID'], order: { ID: 'ASC' }, start });
    for (const d of (res.result || [])) {
      const c = d.COMPANY_ID;
      if (c && String(c) !== '0') dc[String(c)] = (dc[String(c)] || 0) + 1;
    }
    if (res.next == null) break;
    start = res.next; await sleep(50);
  }
  return dc;
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
    // Число сделок на компанию — ПОЛНЫМ сканом всех сделок (любая стадия, любая
    // воронка, включая завершённые/проигранные). Раньше брали из зеркала статистики
    // (ticketsmodule_stat_deals) — оно охватывает только часть сделок, поэтому у
    // компаний с закрытыми сделками показывался 0. Если скан не удался — откат на зеркало.
    let dc = {};
    try {
      dc = await allDealCounts();
    } catch (e) {
      console.error('companies allDealCounts failed, fallback to stat mirror:', e.message);
      try {
        const r = await pool.query("SELECT company_id, COUNT(*)::int AS n FROM ticketsmodule_stat_deals WHERE company_id IS NOT NULL GROUP BY company_id");
        r.rows.forEach(x => { dc[String(x.company_id)] = x.n; });
      } catch (e2) { /* зеркала может не быть — не критично */ }
    }

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
    // После полного пересоздания зеркала возвращаем пометку слитых дублей из журнала,
    // иначе слитые компании «всплывали» бы снова после «Обновить».
    try {
      await pool.query(`UPDATE ticketsmodule_companies c SET merged_into = s.canonical_id
        FROM (SELECT DISTINCT ON (duplicate_id) duplicate_id, canonical_id
              FROM ticketsmodule_company_merges WHERE undone = FALSE
              ORDER BY duplicate_id, id DESC) s
        WHERE c.id = s.duplicate_id`);
    } catch (e) { /* журнала может не быть — не критично */ }
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
// Имена-заглушки — не сигнал дубля (разные реальные компании с шаблонной подписью).
const GENERIC_NAMES = new Set([
  'юридическое лицо', 'физическое лицо', 'новый клиент', 'новая компания', 'клиент',
  'компания', 'контакт', 'без названия', 'организация', 'покупатель', 'заказчик',
  'new client', 'new company', 'company', 'client', 'contact', 'customer',
  'тест', 'test', 'проверка',
]);
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
  const base = portalBase();
  const out = rows.map(r => {
    const problems = problemsOf(r, dupNames);
    return {
      id: r.id, title: r.title, industryId: r.industry_id || '', industryName: r.industry_name || (r.industry_id ? (inds[r.industry_id] || r.industry_id) : ''),
      bin: r.bin || '', email: r.email || '', phone: r.phone || '',
      owner: uname(r.assigned_bid), city: r.city || '', createdAt: r.created_at,
      dealCount: Number(r.deal_count || 0), problems,
      mergedInto: r.merged_into || '',
      url: base ? `${base}/crm/company/details/${r.id}/` : '',
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
  // Bitrix на ошибку прав/валидации отвечает HTTP 200 с {error} в теле — обёртка
  // b24 бросает только на 4xx/5xx, поэтому логическую ошибку ловим здесь явно,
  // иначе «сохранилось» в ЦУП, а в Битриксе нет.
  const resp = await b24('crm.company.update', { id, fields });
  if (resp && resp.error) throw new Error('Bitrix: ' + (resp.error_description || resp.error));
  if (resp && resp.result === false) throw new Error('Битрикс отклонил обновление (возможно, нет прав на эту компанию)');
  // Контрольное чтение: убеждаемся, что Битрикс реально применил значения.
  try {
    const { result: chk } = await b24('crm.company.get', { id });
    if (chk) {
      if (fields.TITLE !== undefined && String(chk.TITLE || '') !== fields.TITLE)
        throw new Error('Битрикс не применил новое название (нет прав на компанию?). В Б24 сейчас: «' + (chk.TITLE || '') + '»');
      if (fields.INDUSTRY !== undefined && String(chk.INDUSTRY || '') !== String(fields.INDUSTRY || ''))
        throw new Error('Битрикс не применил сферу деятельности (нет прав на компанию?)');
    }
  } catch (e) { if (/Битрикс не применил/.test(e.message)) throw e; /* чтение-проверку не считаем фатальной иначе */ }
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
  // Уже слитые дубли из поиска исключаем — они разрешены.
  rows = rows.filter(r => !r.merged_into);
  const inds = await industryMap();
  const base = portalBase();

  const n = rows.length;
  const key = { bin: [], name: [], email: [], phone: [] };
  const freqEmail = {}, freqPhone = {}, freqName = {};
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    key.bin[i] = String(r.bin || '').replace(/\D+/g, '');
    const nm = normName(r.title);
    // Имена-заглушки («юридическое лицо», «новый клиент» и т.п.) — НЕ ключ дедупа:
    // это шаблонные подписи разных реальных компаний, их нельзя сливать по названию.
    key.name[i] = (nm.length >= 3 && !GENERIC_NAMES.has(nm)) ? nm : '';
    key.email[i] = normEmail(r.email);
    key.phone[i] = normPhone(r.phone);
    if (key.name[i]) freqName[key.name[i]] = (freqName[key.name[i]] || 0) + 1;
    if (key.email[i]) freqEmail[key.email[i]] = (freqEmail[key.email[i]] || 0) + 1;
    if (key.phone[i]) freqPhone[key.phone[i]] = (freqPhone[key.phone[i]] || 0) + 1;
  }
  // «Шумные» значения — встречаются у многих компаний → не используем для склейки:
  // общий e-mail/телефон приёмной, а также слишком частое название (тоже заглушка).
  const NOISE = 4, NAME_NOISE = 5;
  for (let i = 0; i < n; i++) {
    if (key.name[i] && freqName[key.name[i]] > NAME_NOISE) key.name[i] = '';
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
        url: base ? `${base}/crm/company/details/${r.id}/` : '',
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

// ── Базовый URL портала Bitrix (из вебхука, без токена) ────────────────────────
// Вебхук вида https://xxx.bitrix24.kz/rest/<uid>/<token>/ — наружу отдаём только origin,
// сами строим ссылки на карточки. Токен клиенту НИКОГДА не уходит.
let _portal = null;
function portalBase() {
  if (_portal !== null) return _portal;
  try { _portal = new URL(process.env.BITRIX_WEBHOOK).origin; }
  catch (e) { _portal = ''; }
  return _portal;
}

// Смарт-процессы, привязанные к компании (companyId). По умолчанию — главный 1058
// («Заявки»). Можно расширить через env CMP_MERGE_SP_TYPES="1058,1036,...".
function spTypes() {
  return String(process.env.CMP_MERGE_SP_TYPES || '1058')
    .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
}

// ── Сделки компании (для «провалиться в сделки» из ЦУП) ────────────────────────
async function getCompanyDeals(companyId) {
  companyId = String(companyId);
  const base = portalBase();
  const deals = [];
  let start = 0, guard = 0;
  while (guard++ < 200) {
    const res = await b24('crm.deal.list', {
      filter: { COMPANY_ID: companyId },
      select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
      order: { ID: 'DESC' }, start,
    });
    for (const d of (res.result || [])) {
      deals.push({
        id: d.ID, title: d.TITLE || ('Сделка #' + d.ID),
        stageId: d.STAGE_ID || '', amount: Number(d.OPPORTUNITY || 0), currency: d.CURRENCY_ID || '',
        owner: uname(d.ASSIGNED_BY_ID ? Number(d.ASSIGNED_BY_ID) : null), createdAt: d.DATE_CREATE || null,
        url: base ? `${base}/crm/deal/details/${d.ID}/` : '',
      });
    }
    if (res.next == null) break;
    start = res.next; await sleep(80);
  }
  return { deals, portal: base, companyUrl: base ? `${base}/crm/company/details/${companyId}/` : '' };
}

// ── Дети компании (для слияния/удаления): id сделок, контактов, SP-элементов ────
async function listDealIds(companyId) {
  const ids = []; let start = 0, guard = 0;
  while (guard++ < 500) {
    const res = await b24('crm.deal.list', { filter: { COMPANY_ID: String(companyId) }, select: ['ID'], order: { ID: 'ASC' }, start });
    for (const d of (res.result || [])) ids.push(d.ID);
    if (res.next == null) break; start = res.next; await sleep(60);
  }
  return ids;
}
async function listContactIds(companyId) {
  const ids = []; let start = 0, guard = 0;
  while (guard++ < 500) {
    const res = await b24('crm.contact.list', { filter: { COMPANY_ID: String(companyId) }, select: ['ID'], order: { ID: 'ASC' }, start });
    for (const c of (res.result || [])) ids.push(c.ID);
    if (res.next == null) break; start = res.next; await sleep(60);
  }
  return ids;
}
async function listItemIds(entityTypeId, companyId) {
  const ids = []; let start = 0, guard = 0;
  while (guard++ < 500) {
    const res = await b24('crm.item.list', { entityTypeId, filter: { companyId: Number(companyId) }, select: ['id'], order: { id: 'ASC' }, start });
    const items = (res.result && res.result.items) || [];
    for (const it of items) ids.push(it.id);
    if (res.next == null) break; start = res.next; await sleep(60);
  }
  return ids;
}
async function childrenOf(companyId) {
  const deals = await listDealIds(companyId);
  const contacts = await listContactIds(companyId);
  const items = {};
  for (const t of spTypes()) { try { items[t] = await listItemIds(t, companyId); } catch (e) { items[t] = []; } }
  const itemsTotal = Object.values(items).reduce((s, a) => s + a.length, 0);
  return { deals, contacts, items, counts: { deals: deals.length, contacts: contacts.length, items: itemsTotal } };
}

// Поля, которые безопасно копировать в эталон (только скаляры; мультиполя не трогаем).
const COPY_FIELDS = ['INDUSTRY', 'ADDRESS_CITY', 'ADDRESS', 'ADDRESS_REGION', 'COMMENTS', 'BANKING_DETAILS'];
async function companyRaw(id) {
  const binCode = await binFieldCode();
  const sel = ['ID', 'TITLE', 'INDUSTRY', 'ADDRESS_CITY', 'ADDRESS', 'ADDRESS_REGION'];
  if (binCode) sel.push(binCode);
  const { result } = await b24('crm.company.get', { id: String(id) });
  return result || {};
}

// ── Предпросмотр слияния: что переедет и какие поля скопируются ────────────────
async function previewMerge(canonicalId, duplicateIds) {
  await ensureSchema();
  canonicalId = String(canonicalId);
  duplicateIds = [...new Set((duplicateIds || []).map(String))].filter(d => d && d !== canonicalId);
  if (!duplicateIds.length) return { ok: false, error: 'Не выбраны дубли для слияния' };
  const base = portalBase();
  const canon = await companyRaw(canonicalId);
  const binCode = await binFieldCode();
  const canonBin = binCode ? firstVal(canon[binCode]) : '';
  const dups = [];
  for (const dupId of duplicateIds) {
    const raw = await companyRaw(dupId);
    const ch = await childrenOf(dupId);
    // какие поля эталона пусты, а у дубля заполнены → предложим скопировать
    const copy = [];
    for (const f of COPY_FIELDS) {
      const cv = String(canon[f] || '').trim(), dv = String(raw[f] || '').trim();
      if (!cv && dv) copy.push({ field: f, value: dv });
    }
    if (binCode && !canonBin && binCode in raw && firstVal(raw[binCode])) copy.push({ field: binCode, value: firstVal(raw[binCode]), isBin: true });
    // дообогащение контактных мультиполей — показываем, сколько значений добавится
    for (const mf of ['EMAIL', 'PHONE', 'WEB']) {
      const canonArr = Array.isArray(canon[mf]) ? canon[mf] : (canon[mf] ? [canon[mf]] : []);
      const dupArr = Array.isArray(raw[mf]) ? raw[mf] : (raw[mf] ? [raw[mf]] : []);
      const have = new Set(canonArr.map(x => String((x && x.VALUE) || x).trim().toLowerCase()).filter(Boolean));
      const addN = dupArr.filter(x => { const v = String((x && x.VALUE) || x).trim().toLowerCase(); return v && !have.has(v); }).length;
      if (addN) copy.push({ field: mf, value: '+' + addN, isMf: true });
    }
    dups.push({
      id: dupId, title: raw.TITLE || ('#' + dupId),
      url: base ? `${base}/crm/company/details/${dupId}/` : '',
      counts: ch.counts, copyFields: copy,
    });
  }
  return {
    ok: true,
    canonical: { id: canonicalId, title: canon.TITLE || ('#' + canonicalId), url: base ? `${base}/crm/company/details/${canonicalId}/` : '' },
    duplicates: dups,
    spTypes: spTypes(),
  };
}

// Обёртка с проверкой: Bitrix на отказ прав отвечает HTTP 200 с {error} в теле,
// а b24 бросает только на 4xx/5xx. Здесь ловим логическую ошибку явно.
async function b24w(method, params) {
  const r = await b24(method, params);
  if (r && r.error) throw new Error('Bitrix: ' + (r.error_description || r.error));
  if (r && r.result === false) throw new Error('Bitrix отклонил операцию (нет прав?)');
  return r;
}

// ── Применение слияния: перенос детей на эталон + копирование полей + пометка ───
async function applyMerge({ canonicalId, duplicateIds, copyFields = true, byUser = '' }) {
  await ensureSchema();
  canonicalId = String(canonicalId);
  duplicateIds = [...new Set((duplicateIds || []).map(String))].filter(d => d && d !== canonicalId);
  if (!duplicateIds.length) return { ok: false, error: 'Не выбраны дубли для слияния' };

  // Без upfront-пробы записи в компанию: на этом портале имя ведётся бизнес-процессом
  // из реквизитов (TITLE через REST откатывается), поэтому проба по TITLE бессмысленна и
  // могла бы случайно сбросить имя эталона из реквизита. Ядро слияния — перенос сделок
  // (crm.deal.update COMPANY_ID) — работает; переименование дубля делаем best-effort.

  const results = [], mergeIds = [];
  const inds = await industryMap();
  const binCode = await binFieldCode();

  for (const dupId of duplicateIds) {
    try {
      const raw = await companyRaw(dupId);
      const prevTitle = raw.TITLE || ('#' + dupId);
      const canon = await companyRaw(canonicalId);
      const ch = await childrenOf(dupId);

      // Переносим детей с ПРОВЕРКОЙ результата и считаем только реально перенесённые
      // (чтобы журнал/откат соответствовали факту, а не намерению).
      const movedDeals = [], movedContacts = [], movedItems = {};
      const failed = { deals: 0, contacts: 0, items: 0 };
      // 1) перенос сделок
      for (const id of ch.deals) { try { await b24w('crm.deal.update', { id, fields: { COMPANY_ID: canonicalId } }); movedDeals.push(id); } catch (e) { failed.deals++; } await sleep(40); }
      // 2) перенос контактов (основная компания)
      for (const id of ch.contacts) { try { await b24w('crm.contact.update', { id, fields: { COMPANY_ID: canonicalId } }); movedContacts.push(id); } catch (e) { failed.contacts++; } await sleep(40); }
      // 3) перенос SP-элементов (companyId)
      for (const [t, ids] of Object.entries(ch.items)) {
        movedItems[t] = [];
        for (const id of ids) { try { await b24w('crm.item.update', { entityTypeId: Number(t), id, fields: { companyId: Number(canonicalId) } }); movedItems[t].push(id); } catch (e) { failed.items++; } await sleep(40); }
      }

      // 4) копирование недостающих полей в эталон
      const copiedFields = {};
      if (copyFields) {
        const fields = {};
        for (const f of COPY_FIELDS) {
          const cv = String(canon[f] || '').trim(), dv = String(raw[f] || '').trim();
          if (!cv && dv) { fields[f] = dv; copiedFields[f] = ''; } // prev эталона был пуст
        }
        if (binCode && !firstVal(canon[binCode]) && binCode in raw && firstVal(raw[binCode])) { fields[binCode] = firstVal(raw[binCode]); copiedFields[binCode] = ''; }
        if (Object.keys(fields).length) { try { await b24('crm.company.update', { id: canonicalId, fields }); } catch (e) { /* best-effort */ } }
      }

      // 4.5) дообогащение контактных мультиполей эталона (EMAIL/PHONE/WEB): добавляем
      //      недостающие значения дубля, НЕ затирая уже имеющиеся у эталона.
      const enrichedMf = {};
      if (copyFields) {
        const upd = {};
        for (const mf of ['EMAIL', 'PHONE', 'WEB']) {
          const canonArr = Array.isArray(canon[mf]) ? canon[mf] : (canon[mf] ? [canon[mf]] : []);
          const dupArr = Array.isArray(raw[mf]) ? raw[mf] : (raw[mf] ? [raw[mf]] : []);
          const have = new Set(canonArr.map(x => String((x && x.VALUE) || x).trim().toLowerCase()).filter(Boolean));
          const add = [], addedVals = [];
          for (const x of dupArr) {
            const v = String((x && x.VALUE) || x).trim();
            if (v && !have.has(v.toLowerCase())) { add.push({ VALUE: v, VALUE_TYPE: (x && x.VALUE_TYPE) || 'WORK' }); have.add(v.toLowerCase()); addedVals.push(v); }
          }
          if (add.length) {
            // чтобы добавить, НЕ затерев существующие — шлём существующие (с ID) + новые
            const existing = canonArr.map(x => ({ ID: x.ID, VALUE: x.VALUE, VALUE_TYPE: x.VALUE_TYPE }));
            upd[mf] = existing.concat(add);
            enrichedMf[mf] = addedVals;
          }
        }
        if (Object.keys(upd).length) { try { await b24('crm.company.update', { id: canonicalId, fields: upd }); } catch (e) { /* best-effort */ } }
      }

      // 5) пометка дубля (переименование) — BEST-EFFORT. На этом портале имя компании
      //    ведётся бизнес-процессом из реквизитов, поэтому TITLE через REST откатывается.
      //    Это НЕ ошибка слияния: сделки/контакты уже перенесены, дубль прячем в ЦУП.
      const newTitle = `[ДУБЛЬ → #${canonicalId}] ${prevTitle}`.slice(0, 500);
      let renamedInB24 = false;
      try { const rr = await b24('crm.company.update', { id: dupId, fields: { TITLE: newTitle } }); renamedInB24 = !(rr && rr.error); } catch (e) { /* имя вернёт БП — не критично */ }

      // 6) журнал (храним РЕАЛЬНО перенесённые id — под откат)
      const moved = { deals: movedDeals, contacts: movedContacts, items: movedItems, copiedFields, enrichedMf };
      const ins = await pool.query(
        `INSERT INTO ticketsmodule_company_merges (canonical_id, canonical_title, duplicate_id, prev_title, moved, by_user)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [canonicalId, canon.TITLE || ('#' + canonicalId), dupId, prevTitle, JSON.stringify(moved), byUser || '']);
      const mergeId = ins.rows[0].id; mergeIds.push(mergeId);

      // 7) зеркало: помечаем дубль + при копировании обновляем поля эталона
      await pool.query('UPDATE ticketsmodule_companies SET merged_into=$1, title=$2, synced_at=NOW() WHERE id=$3', [canonicalId, newTitle, dupId]);
      if (copyFields && copiedFields.INDUSTRY !== undefined) {
        const nv = raw.INDUSTRY || '';
        await pool.query('UPDATE ticketsmodule_companies SET industry_id=$1, industry_name=$2 WHERE id=$3 AND (industry_id IS NULL OR industry_id=\'\')', [nv, inds[nv] || '', canonicalId]);
      }

      const enrichedCount = Object.values(enrichedMf).reduce((s, a) => s + a.length, 0);
      const movedCounts = { deals: movedDeals.length, contacts: movedContacts.length, items: Object.values(movedItems).reduce((s, a) => s + a.length, 0) };
      results.push({ dupId, ok: true, mergeId, moved: movedCounts, failed, copied: Object.keys(copiedFields), enriched: enrichedCount });
    } catch (e) {
      results.push({ dupId, ok: false, error: String(e && e.message || e) });
    }
  }
  return { ok: results.some(r => r.ok), canonicalId, results, mergeIds };
}

// ── Откат слияния по журналу ───────────────────────────────────────────────────
async function undoMerge(mergeId, byUser = '') {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_company_merges WHERE id=$1', [mergeId]);
  const m = rows[0];
  if (!m) return { ok: false, error: 'Запись слияния не найдена' };
  if (m.undone) return { ok: false, error: 'Уже откатано' };
  const moved = m.moved || {};
  const dupId = m.duplicate_id, canonId = m.canonical_id;

  // возвращаем детей дублю
  for (const id of (moved.deals || [])) { try { await b24('crm.deal.update', { id, fields: { COMPANY_ID: dupId } }); } catch (e) { /* */ } await sleep(40); }
  for (const id of (moved.contacts || [])) { try { await b24('crm.contact.update', { id, fields: { COMPANY_ID: dupId } }); } catch (e) { /* */ } await sleep(40); }
  for (const [t, ids] of Object.entries(moved.items || {})) {
    for (const id of ids) { try { await b24('crm.item.update', { entityTypeId: Number(t), id, fields: { companyId: Number(dupId) } }); } catch (e) { /* */ } await sleep(40); }
  }
  // откатываем скопированные в эталон поля (они были пусты)
  const cf = moved.copiedFields || {};
  if (Object.keys(cf).length) {
    const fields = {}; for (const f of Object.keys(cf)) fields[f] = '';
    try { await b24('crm.company.update', { id: canonId, fields }); } catch (e) { /* */ }
  }
  // убираем значения, которыми дообогащали эталон (EMAIL/PHONE/WEB) — только добавленные
  const enriched = moved.enrichedMf || {};
  for (const mf of Object.keys(enriched)) {
    const vals = new Set((enriched[mf] || []).map(v => String(v).trim().toLowerCase()));
    if (!vals.size) continue;
    try {
      const { result: cur } = await b24('crm.company.get', { id: canonId });
      const arr = Array.isArray(cur[mf]) ? cur[mf] : (cur[mf] ? [cur[mf]] : []);
      const list = arr.map(x => vals.has(String(x.VALUE || '').trim().toLowerCase())
        ? { ID: x.ID, DELETE: 'Y' } : { ID: x.ID, VALUE: x.VALUE, VALUE_TYPE: x.VALUE_TYPE });
      if (list.some(e => e.DELETE)) await b24('crm.company.update', { id: canonId, fields: { [mf]: list } });
    } catch (e) { /* */ }
  }
  // возвращаем имя дубля
  try { await b24('crm.company.update', { id: dupId, fields: { TITLE: m.prev_title } }); } catch (e) { /* */ }

  await pool.query('UPDATE ticketsmodule_companies SET merged_into=NULL, title=$1, synced_at=NOW() WHERE id=$2', [m.prev_title, dupId]);
  await pool.query('UPDATE ticketsmodule_company_merges SET undone=TRUE, undone_at=NOW() WHERE id=$1', [mergeId]);
  return { ok: true, mergeId, duplicateId: dupId, restoredTitle: m.prev_title };
}

async function listMerges(limit = 100) {
  await ensureSchema();
  const base = portalBase();
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_company_merges ORDER BY id DESC LIMIT $1', [Math.min(500, Number(limit) || 100)]);
  return {
    merges: rows.map(m => {
      const moved = m.moved || {};
      const itemsN = Object.values(moved.items || {}).reduce((s, a) => s + (a ? a.length : 0), 0);
      return {
        id: m.id, canonicalId: m.canonical_id, canonicalTitle: m.canonical_title,
        duplicateId: m.duplicate_id, prevTitle: m.prev_title,
        moved: { deals: (moved.deals || []).length, contacts: (moved.contacts || []).length, items: itemsN },
        byUser: m.by_user || '', undone: m.undone, createdAt: m.created_at, undoneAt: m.undone_at,
        canonicalUrl: base ? `${base}/crm/company/details/${m.canonical_id}/` : '',
        duplicateUrl: base ? `${base}/crm/company/details/${m.duplicate_id}/` : '',
      };
    }),
  };
}

// ── Удаление компании из Б24 (необратимо) — только если нет привязанных детей ───
async function deleteCompany(id) {
  await ensureSchema();
  id = String(id);
  const ch = await childrenOf(id);
  if (ch.counts.deals || ch.counts.contacts || ch.counts.items) {
    return { ok: false, error: 'Нельзя удалить: есть привязанные объекты', counts: ch.counts, suggestMerge: true };
  }
  await b24('crm.company.delete', { id });
  await pool.query('DELETE FROM ticketsmodule_companies WHERE id=$1', [id]);
  return { ok: true, id };
}

// ── Диагностика записи в Б24: пишем метку в название, читаем, откатываем ───────
// Возвращает СЫРОЙ ответ Bitrix на update — чтобы точно увидеть, применяется ли запись.
async function writeSelfTest(id, { keep = false } = {}) {
  id = String(id || '');
  if (!id) return { ok: false, error: 'Укажите ?id=<id компании>' };
  const base = portalBase();
  const webhookUser = (process.env.BITRIX_WEBHOOK || '').replace(/^(https?:\/\/[^/]+\/rest\/)(\d+)\/.*/, '$2') || '(не определить)';
  const tag = '[diag' + (Date.now() % 100000) + ']';
  const before = await companyRaw(id);
  if (!before || !before.ID) return { ok: false, error: 'Компания не найдена: ' + id };

  // Тест 1 — название компании (TITLE)
  const origTitle = before.TITLE || ('#' + id);
  const titleTry = (origTitle + ' ' + tag).slice(0, 250);
  const rTitle = await b24('crm.company.update', { id, fields: { TITLE: titleTry } });
  // Тест 2 — комментарий компании (COMMENTS) — отдельное поле
  const origComm = before.COMMENTS || '';
  const commTry = (origComm + ' ' + tag).trim();
  const rComm = await b24('crm.company.update', { id, fields: { COMMENTS: commTry } });
  await sleep(1200);
  const mid = await companyRaw(id);
  const titleApplied = String(mid.TITLE || '') === titleTry;
  const commApplied = String(mid.COMMENTS || '').includes(tag);

  // Тест 3 — запись в СДЕЛКУ (от этого зависит слияние): COMMENTS сделки этой компании,
  // а если у компании сделок нет — берём ЛЮБУЮ сделку портала (нам важен сам факт записи).
  let deal = null;
  try {
    let dealIds = await listDealIds(id);
    let source = 'компания';
    if (!dealIds.length) {
      const any = await b24('crm.deal.list', { select: ['ID'], order: { ID: 'DESC' }, start: 0 });
      dealIds = (any.result || []).slice(0, 1).map(d => d.ID);
      source = 'любая сделка портала';
    }
    if (dealIds.length) {
      const did = dealIds[0];
      const dg = await b24('crm.deal.get', { id: did });
      const dOrig = (dg.result && dg.result.COMMENTS) || '';
      const dTry = (dOrig + ' ' + tag).trim();
      const rDeal = await b24('crm.deal.update', { id: did, fields: { COMMENTS: dTry } });
      await sleep(800);
      const dg2 = await b24('crm.deal.get', { id: did });
      const dApplied = String((dg2.result && dg2.result.COMMENTS) || '').includes(tag);
      deal = { dealId: did, source, updateResult: rDeal && rDeal.result, applied: dApplied };
      if (!keep) { try { await b24('crm.deal.update', { id: did, fields: { COMMENTS: dOrig } }); } catch (e) { } }
    } else { deal = { note: 'сделок на портале не нашлось' }; }
  } catch (e) { deal = { error: String(e && e.message || e) }; }

  // Тест 3b — ПЕРЕНОС сделки на другую компанию (ровно операция слияния: COMPANY_ID).
  // Если это держится — слияние реально переносит сделки; если откатывается — нет.
  let dealReassign = null;
  try {
    let dids = await listDealIds(id);
    if (!dids.length) { const any = await b24('crm.deal.list', { select: ['ID'], order: { ID: 'DESC' }, start: 0 }); dids = (any.result || []).slice(0, 1).map(d => d.ID); }
    if (dids.length) {
      const did = dids[0];
      const dg = await b24('crm.deal.get', { id: did });
      const origCompany = (dg.result && dg.result.COMPANY_ID) || '0';
      const cl = await b24('crm.company.list', { select: ['ID'], order: { ID: 'ASC' }, start: 0 });
      const target = (cl.result || []).map(c => String(c.ID)).filter(x => x !== String(origCompany))[0];
      if (!target) { dealReassign = { note: 'нет второй компании для теста' }; }
      else {
        const r = await b24('crm.deal.update', { id: did, fields: { COMPANY_ID: target } });
        await sleep(900);
        const dg2 = await b24('crm.deal.get', { id: did });
        const now = String((dg2.result && dg2.result.COMPANY_ID) || '0');
        dealReassign = { dealId: did, origCompany: String(origCompany), target, after: now, applied: now === String(target), updateResult: r && r.result };
        if (!keep) { try { await b24('crm.deal.update', { id: did, fields: { COMPANY_ID: origCompany } }); } catch (e) { } }
      }
    } else dealReassign = { note: 'сделок нет' };
  } catch (e) { dealReassign = { error: String(e && e.message || e) }; }

  // Тест 4 — та же запись названия, но ПРЯМЫМ JSON-телом (минуя наш form-encoding).
  // Если так применяется, а через b24 нет — проблема в кодировании тела запроса.
  let jsonWay = null;
  try {
    const fetch = require('node-fetch');
    const wh = process.env.BITRIX_WEBHOOK;
    const jTry = (origTitle + ' ' + tag + 'J').slice(0, 250);
    const resp = await fetch(wh + 'crm.company.update.json', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, fields: { TITLE: jTry } }),
    });
    const jRaw = await resp.json();
    await sleep(1000);
    const m3 = await companyRaw(id);
    jsonWay = { applied: String(m3.TITLE || '') === jTry, httpStatus: resp.status, raw: jRaw };
  } catch (e) { jsonWay = { error: String(e && e.message || e) }; }

  if (!keep) { try { await b24('crm.company.update', { id, fields: { TITLE: origTitle, COMMENTS: origComm } }); } catch (e) { } }

  return {
    ok: true, id, portal: base, webhookUser, kept: keep,
    companyTitle: { applied: titleApplied, tried: titleTry, after: mid.TITLE, updateResult: rTitle && rTitle.result },
    companyComments: { applied: commApplied, updateResult: rComm && rComm.result },
    deal,
    dealReassign,
    companyTitleJson: jsonWay,
    verdict: (titleApplied || commApplied || (deal && deal.applied) || (jsonWay && jsonWay.applied)) ? 'запись где-то применяется' : 'НИ ОДНА запись не применилась',
  };
}

module.exports = {
  ensureSchema, syncCompanies, getCompaniesBoard, updateCompany, industryOptions,
  getDuplicateGroups, getCompanyDeals, previewMerge, applyMerge, undoMerge, listMerges, deleteCompany, writeSelfTest,
};

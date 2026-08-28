// НКТ — модуль регистрации товаров в Национальном каталоге. Этап 1:
// мастер (наименование → партномер → дубли → имена → ОКТРУ) + реестр черновиков в
// БД ЦУП + отправка заявки (create/moderation) и трекинг статуса.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const nct = require('../nct-api');
const ai = require('../nct-ai');

const ROLES = ['admin', 'coordinator', 'manager', 'engineer'];

// ── Таблица реестра/черновиков ──────────────────────────────────────────────────
let _ready = false;
async function ensureTable() {
  if (_ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_nct_drafts (
    id SERIAL PRIMARY KEY,
    full_name_ru TEXT NOT NULL,
    short_name_ru TEXT,
    name_kk TEXT,
    part_number TEXT,
    part_confirmed BOOLEAN DEFAULT false,
    has_no_part BOOLEAN DEFAULT false,
    article_raw TEXT,
    article_norm TEXT,
    brand TEXT,
    model TEXT,
    role TEXT,
    oktru TEXT,
    oktru_path TEXT,
    tnved TEXT,
    attributes JSONB DEFAULT '[]',
    ai_parse JSONB,
    ai_oktru JSONB,
    answers JSONB DEFAULT '{}',
    request_id BIGINT,
    ntin TEXT, kztin TEXT, gtin TEXT,
    internal_status TEXT DEFAULT 'started',
    nct_status TEXT,
    dup_override BOOLEAN DEFAULT false,
    history JSONB DEFAULT '[]',
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_nct_article_norm ON ticketsmodule_nct_drafts(article_norm)');
  _ready = true;
}
function who(req) { return (req.user && (req.user.display_name || req.user.engineer_name || req.user.username)) || 'сотрудник'; }
function histEntry(req, action, note) { return { at: new Date().toISOString(), user: who(req), action, note: note || '' }; }

// ── Кэш справочников (rate limit НКТ) ────────────────────────────────────────────
const cache = {};
async function cached(key, ttlMs, fn) {
  const c = cache[key];
  if (c && Date.now() - c.t < ttlMs) return c.v;
  const v = await fn(); cache[key] = { t: Date.now(), v }; return v;
}

// ── Health ───────────────────────────────────────────────────────────────────────
router.get('/health', requireAuth(ROLES), async (req, res) => {
  try { await ensureTable(); const h = await nct.health(); h.llm = !!process.env.ANTHROPIC_API_KEY; res.json(h); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── AI: разбор наименования ───────────────────────────────────────────────────────
router.post('/parse', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const fullName = String((req.body || {}).fullName || '').trim();
    if (!fullName) return res.status(400).json({ error: 'Пустое наименование' });
    const parse = await ai.parseName(fullName);
    if (!parse) return res.status(502).json({ error: 'AI не смог разобрать наименование, попробуйте ещё раз' });
    (parse.partCandidates || []).forEach(c => { c.norm = ai.normalizeArticle(c.value); });
    res.json({ ok: true, parse });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Проверка дублей по артикулу (внутренний реестр ЦУП; Bitrix-список — когда дадут ID) ──
router.post('/dedup/article', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    await ensureTable();
    const article = String((req.body || {}).article || '').trim();
    const norm = ai.normalizeArticle(article);
    if (!norm) return res.json({ ok: true, exact: [], possible: [], norm });
    const { rows } = await pool.query(
      `SELECT id, full_name_ru, short_name_ru, part_number, article_raw, article_norm, brand, model, ntin, kztin, internal_status, nct_status
       FROM ticketsmodule_nct_drafts WHERE article_norm IS NOT NULL AND article_norm <> ''`);
    const exact = [], possible = [];
    for (const r of rows) {
      if (r.article_norm === norm) exact.push(r);
      else if (ai.articleSimilar(norm, r.article_norm)) possible.push(r);
    }
    res.json({ ok: true, norm, exact, possible, internalRegistry: 'local', note: exact.length ? 'Точное совпадение — создание блокируется до решения исполнителя.' : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Проверка дублей по наименованию: каталог НКТ + внутренний реестр ────────────────
router.post('/dedup/name', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    await ensureTable();
    const b = req.body || {};
    const q = [b.name, b.brand, b.model, b.partNumber].filter(Boolean).join(' ').trim() || String(b.name || '');
    let catalog = [];
    try {
      const s = await nct.searchCatalog(q, 0, 10);
      catalog = (s && s.items || []).map(it => ({ id: it.id, nameRu: it.nameRu, ntin: it.ntin, gtin: it.gtin, kztin: it.kztin, category: it.categoryNameRuL4 || it.categoryNameRuL1 || '', url: it.id ? `https://nationalcatalog.kz/ru/product/${it.id}` : null }));
    } catch (e) { catalog = []; }
    // внутренний реестр по словам наименования
    const words = String(b.name || '').toLowerCase().split(/\s+/).filter(w => w.length >= 4).slice(0, 6);
    let internal = [];
    if (words.length) {
      const conds = words.map((_, i) => `lower(full_name_ru) LIKE $${i + 1}`).join(' OR ');
      const params = words.map(w => `%${w}%`);
      const { rows } = await pool.query(`SELECT id, full_name_ru, short_name_ru, part_number, ntin, kztin, internal_status FROM ticketsmodule_nct_drafts WHERE ${conds} LIMIT 20`, params);
      internal = rows;
    }
    res.json({ ok: true, query: q, catalog, internal });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: краткое имя / перевод ─────────────────────────────────────────────────────
router.post('/shortname', requireAuth(ROLES), express.json(), async (req, res) => {
  try { const b = req.body || {}; res.json({ ok: true, shortNameRu: await ai.shortNameRu(String(b.fullName || ''), b.elements || {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/translate', requireAuth(ROLES), express.json(), async (req, res) => {
  try { res.json({ ok: true, nameKk: await ai.translateKk(String((req.body || {}).text || '')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Справочники / ОКТРУ ───────────────────────────────────────────────────────────
router.get('/dictionaries', requireAuth(ROLES), async (req, res) => {
  try { res.json({ ok: true, items: await cached('dicts', 6 * 3600e3, () => nct.listDictionaries()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/oktru/roots', requireAuth(ROLES), async (req, res) => {
  try { res.json({ ok: true, items: await cached('oktru:roots', 6 * 3600e3, () => nct.dictRoots('OKTRU')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/oktru/children/:parentId', requireAuth(ROLES), async (req, res) => {
  try { res.json({ ok: true, items: await cached('oktru:ch:' + req.params.parentId, 6 * 3600e3, () => nct.dictChildren('OKTRU', parseInt(req.params.parentId, 10))) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/dict/:code/items', requireAuth(ROLES), async (req, res) => {
  try { const page = parseInt(req.query.page, 10) || 1, size = Math.min(parseInt(req.query.size, 10) || 50, 100); res.json({ ok: true, data: await nct.dictItems(req.params.code, page, size) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/oktru/suggest', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const roots = await cached('oktru:roots', 6 * 3600e3, () => nct.dictRoots('OKTRU'));
    const hints = (roots || []).map(r => ({ code: (r.properties && r.properties.code) || r.code, name: (r.properties && r.properties.nameRu) || r.nameRu, id: r.id, hasChild: r.hasChild }));
    const out = await ai.suggestOktru((req.body || {}).ctx || {}, hints);
    res.json({ ok: true, roots: hints, suggest: out || { questions: [], suggestions: [] } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Атрибуты (для формы характеристик) ────────────────────────────────────────────
router.get('/attributes', requireAuth(ROLES), async (req, res) => {
  try { res.json({ ok: true, attributes: await cached('attrs', 3600e3, () => nct.getAttributes()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Черновики / реестр ────────────────────────────────────────────────────────────
const FIELDS = ['full_name_ru', 'short_name_ru', 'name_kk', 'part_number', 'part_confirmed', 'has_no_part', 'article_raw', 'article_norm', 'brand', 'model', 'role', 'oktru', 'oktru_path', 'tnved', 'attributes', 'ai_parse', 'ai_oktru', 'answers', 'ntin', 'kztin', 'gtin', 'internal_status', 'dup_override'];

router.get('/drafts', requireAuth(ROLES), async (req, res) => {
  try {
    await ensureTable();
    const st = req.query.status;
    const { rows } = await pool.query(
      `SELECT id, full_name_ru, short_name_ru, part_number, article_raw, oktru, oktru_path, ntin, kztin, internal_status, nct_status, request_id, created_by, updated_at
       FROM ticketsmodule_nct_drafts ${st ? 'WHERE internal_status=$1' : ''} ORDER BY updated_at DESC LIMIT 500`, st ? [st] : []);
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/drafts/:id', requireAuth(ROLES), async (req, res) => {
  try { await ensureTable(); const { rows } = await pool.query('SELECT * FROM ticketsmodule_nct_drafts WHERE id=$1', [req.params.id]); if (!rows[0]) return res.status(404).json({ error: 'Не найдено' }); res.json({ ok: true, item: rows[0] }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/drafts', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    await ensureTable();
    const b = req.body || {};
    if (!String(b.full_name_ru || '').trim()) return res.status(400).json({ error: 'full_name_ru обязателен' });
    if (b.article_raw != null && (b.article_norm == null)) b.article_norm = ai.normalizeArticle(b.article_raw);
    const cols = FIELDS.filter(f => b[f] !== undefined);
    const vals = cols.map(f => (['attributes', 'ai_parse', 'ai_oktru', 'answers'].includes(f) && typeof b[f] !== 'string') ? JSON.stringify(b[f]) : b[f]);
    cols.push('created_by', 'history'); vals.push(who(req), JSON.stringify([histEntry(req, 'created')]));
    const ph = cols.map((_, i) => `$${i + 1}`).join(',');
    const { rows } = await pool.query(`INSERT INTO ticketsmodule_nct_drafts (${cols.join(',')}) VALUES (${ph}) RETURNING id`, vals);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/drafts/:id', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    await ensureTable();
    const b = req.body || {};
    if (b.article_raw != null) b.article_norm = ai.normalizeArticle(b.article_raw);
    const cols = FIELDS.filter(f => b[f] !== undefined);
    if (!cols.length) return res.json({ ok: true });
    const sets = cols.map((f, i) => `${f}=$${i + 1}`);
    const vals = cols.map(f => (['attributes', 'ai_parse', 'ai_oktru', 'answers'].includes(f) && typeof b[f] !== 'string') ? JSON.stringify(b[f]) : b[f]);
    vals.push(req.params.id);
    let sql = `UPDATE ticketsmodule_nct_drafts SET ${sets.join(',')}, updated_at=NOW()`;
    if (b._hist) { sql += `, history = history || $${vals.length + 1}::jsonb`; vals.push(JSON.stringify([histEntry(req, b._hist, b._histNote)])); }
    sql += ` WHERE id=$${cols.length + 1}`;
    await pool.query(sql, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/drafts/:id', requireAuth(ROLES), async (req, res) => {
  try { await ensureTable(); await pool.query('DELETE FROM ticketsmodule_nct_drafts WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Отправка заявки в НКТ (create + moderation) ──────────────────────────────────
router.post('/drafts/:id/submit', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT * FROM ticketsmodule_nct_drafts WHERE id=$1', [req.params.id]);
    const d = rows[0]; if (!d) return res.status(404).json({ error: 'Не найдено' });
    if (!d.oktru) return res.status(400).json({ error: 'Не подтверждён ОКТРУ' });
    // атрибуты: имя (полное), каз., gtin + сохранённые характеристики
    const attrs = Array.isArray(d.attributes) ? d.attributes.slice() : [];
    const upsert = (code, value) => { if (value == null || value === '') return; const e = attrs.find(a => a.code === code); if (e) e.value = value; else attrs.push({ code, value }); };
    upsert('name_ru', d.full_name_ru);
    upsert('name_kk', d.name_kk);
    if (d.gtin) upsert('gtin', d.gtin);
    const auto = !!(req.body || {}).autoPublication;
    const created = await nct.createRequest({ oktru: d.oktru, autoPublication: auto, attributes: attrs });
    const reqId = created && created.id;
    if (!reqId) throw new Error('НКТ не вернул id заявки');
    let modStatus = 'onModeration';
    try { await nct.sendModeration(reqId); } catch (e) { modStatus = 'new'; }
    await pool.query(`UPDATE ticketsmodule_nct_drafts SET request_id=$1, internal_status='submitted', nct_status=$2, updated_at=NOW(),
      history = history || $3::jsonb WHERE id=$4`, [reqId, modStatus, JSON.stringify([histEntry(req, 'submitted', 'заявка ' + reqId)]), d.id]);
    res.json({ ok: true, requestId: reqId, nctStatus: modStatus });
  } catch (e) { res.status(500).json({ error: e.message, body: e.body || null }); }
});

// ── Обновить статус заявки; при завершении — вытащить NTIN ────────────────────────
router.post('/drafts/:id/refresh', requireAuth(ROLES), async (req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query('SELECT id, request_id, full_name_ru FROM ticketsmodule_nct_drafts WHERE id=$1', [req.params.id]);
    const d = rows[0]; if (!d) return res.status(404).json({ error: 'Не найдено' });
    if (!d.request_id) return res.status(400).json({ error: 'Заявка не отправлена' });
    const st = await nct.getRequestStatus(d.request_id);
    const code = st && st.code || null;
    let ntin = null;
    if (code === 'completed') {
      try { const det = await nct.getRequestDetails(d.request_id); const a = (det && det.attributes || []).find(x => x.code === 'ntin'); ntin = a && (a.value || a.valueRu); } catch (_) {}
      if (!ntin) { try { const s = await nct.searchCatalog(d.full_name_ru, 0, 3); ntin = (s && s.items && s.items[0] && s.items[0].ntin) || null; } catch (_) {} }
    }
    const internal = code === 'completed' ? 'completed' : (code === 'underRevision' || code === 'underRevisionGz' ? 'revision' : (code === 'rejected' || code === 'rejectedGz' ? 'rejected' : 'submitted'));
    await pool.query(`UPDATE ticketsmodule_nct_drafts SET nct_status=$1, internal_status=$2 ${ntin ? ', ntin=$4' : ''}, updated_at=NOW() WHERE id=$3`,
      ntin ? [code, internal, d.id, ntin] : [code, internal, d.id]);
    res.json({ ok: true, nctStatus: code, ntin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/drafts/:id/publish', requireAuth(ROLES), async (req, res) => {
  try { const { rows } = await pool.query('SELECT request_id FROM ticketsmodule_nct_drafts WHERE id=$1', [req.params.id]); if (!rows[0] || !rows[0].request_id) return res.status(400).json({ error: 'Нет заявки' }); await nct.publishRequest(rows[0].request_id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/drafts/:id/cancel', requireAuth(ROLES), async (req, res) => {
  try { const { rows } = await pool.query('SELECT request_id FROM ticketsmodule_nct_drafts WHERE id=$1', [req.params.id]); if (!rows[0] || !rows[0].request_id) return res.status(400).json({ error: 'Нет заявки' }); await nct.cancelRequest(rows[0].request_id); await pool.query(`UPDATE ticketsmodule_nct_drafts SET internal_status='cancelled', nct_status='cancelled', updated_at=NOW() WHERE id=$1`, [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

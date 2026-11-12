// База знаний ЦУП (RAG): регламенты / алгоритмы / инструкции компании.
// Документ режется на фрагменты, индексируется в Postgres (полнотекст + триграммы).
// Агент (plsai-agent) достаёт релевантные фрагменты и отвечает ПО НИМ со ссылкой
// на источник. Модель не дообучается — только извлечение; правка документа сразу
// меняет ответы. Семантика (pgvector) — следующий шаг, схема к ней готова.
const { pool } = require('./auth');

// ── Эмбеддинги (семантика) — опционально, через внешний OpenAI-совместимый
// эндпоинт. Включается переменными окружения; выключено → работает обычный
// гибрид (FTS + триграммы), ничего не ломается. Для бесплатного локального
// варианта: Ollama → EMBED_URL=http://<host>:11434/v1/embeddings, EMBED_MODEL=nomic-embed-text, EMBED_DIM=768.
const EMBED = {
  url: process.env.EMBED_URL || '',
  key: process.env.EMBED_KEY || '',
  model: process.env.EMBED_MODEL || '',
  dim: parseInt(process.env.EMBED_DIM, 10) || 768,
};
function embedConfigured() { return !!(EMBED.url && EMBED.model); }
async function embedText(text) {
  if (!embedConfigured()) return null;
  try {
    const r = await fetch(EMBED.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, EMBED.key ? { Authorization: 'Bearer ' + EMBED.key } : {}),
      body: JSON.stringify({ model: EMBED.model, input: String(text || '').slice(0, 8000) }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const v = d && d.data && d.data[0] && d.data[0].embedding;
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) { return null; }
}
const vecLit = arr => '[' + arr.map(x => (+x).toFixed(6)).join(',') + ']';
let _vecReady = false, _vecOk = false;
async function ensureVectorColumn() {
  if (_vecReady) return _vecOk;
  _vecReady = true;
  if (!embedConfigured()) return false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    await pool.query(`ALTER TABLE ticketsmodule_kb_chunks ADD COLUMN IF NOT EXISTS embedding vector(${EMBED.dim})`);
    try { await pool.query('CREATE INDEX IF NOT EXISTS idx_kb_chunks_vec ON ticketsmodule_kb_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)'); } catch (e) {}
    _vecOk = true;
  } catch (e) { console.error('kb vector setup:', e.message); _vecOk = false; }
  return _vecOk;
}

let _ready = false;
async function ensureKbSchema() {
  if (_ready) return;
  try { await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm'); } catch (e) { /* нет прав — триграммы отключатся, FTS останется */ }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_kb_docs (
      id SERIAL PRIMARY KEY,
      title VARCHAR(300) NOT NULL,
      category VARCHAR(120),
      source VARCHAR(300),
      body TEXT,
      created_by VARCHAR(120),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ticketsmodule_kb_chunks (
      id SERIAL PRIMARY KEY,
      doc_id INTEGER NOT NULL,
      doc_title VARCHAR(300),
      category VARCHAR(120),
      chunk TEXT NOT NULL,
      ord INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_fts ON ticketsmodule_kb_chunks USING GIN (to_tsvector('russian', chunk));
  `);
  try { await pool.query(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_trgm ON ticketsmodule_kb_chunks USING GIN (chunk gin_trgm_ops)`); } catch (e) {}
  _ready = true;
}

// Нарезка текста на фрагменты ~700 символов по абзацам, с сохранением заголовка.
function chunkText(text) {
  const clean = String(text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const paras = clean.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > 800 && buf) { out.push(buf.trim()); buf = p; }
    else buf = buf ? (buf + '\n\n' + p) : p;
    // очень длинный абзац — режем по предложениям
    while (buf.length > 1100) {
      let cut = buf.lastIndexOf('. ', 900); if (cut < 400) cut = 900;
      out.push(buf.slice(0, cut + 1).trim()); buf = buf.slice(cut + 1).trim();
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function reindexDoc(docId) {
  const d = await pool.query('SELECT id, title, category, body FROM ticketsmodule_kb_docs WHERE id=$1', [docId]);
  const doc = d.rows[0]; if (!doc) return;
  await pool.query('DELETE FROM ticketsmodule_kb_chunks WHERE doc_id=$1', [docId]);
  const chunks = chunkText(doc.body);
  for (let i = 0; i < chunks.length; i++) {
    await pool.query('INSERT INTO ticketsmodule_kb_chunks (doc_id, doc_title, category, chunk, ord) VALUES ($1,$2,$3,$4,$5)',
      [docId, doc.title, doc.category || '', chunks[i], i]);
  }
  // Семантические эмбеддинги (если провайдер настроен) — считаем по фрагментам.
  try {
    if (await ensureVectorColumn()) {
      const cr = await pool.query('SELECT id, chunk FROM ticketsmodule_kb_chunks WHERE doc_id=$1', [docId]);
      for (const row of cr.rows) {
        const v = await embedText(row.chunk); if (!v) continue;
        try { await pool.query('UPDATE ticketsmodule_kb_chunks SET embedding=$1::vector WHERE id=$2', [vecLit(v), row.id]); } catch (e) {}
      }
    }
  } catch (e) { /* эмбеддинги опциональны */ }
  return chunks.length;
}

async function listDocs() {
  await ensureKbSchema();
  const r = await pool.query(`SELECT d.id, d.title, d.category, d.source, d.created_by, d.updated_at,
    (SELECT COUNT(*) FROM ticketsmodule_kb_chunks c WHERE c.doc_id=d.id)::int AS chunks,
    char_length(d.body) AS len FROM ticketsmodule_kb_docs d ORDER BY d.updated_at DESC`);
  return r.rows;
}
async function getDoc(id) {
  await ensureKbSchema();
  const r = await pool.query('SELECT * FROM ticketsmodule_kb_docs WHERE id=$1', [id]);
  return r.rows[0] || null;
}
async function addDoc({ title, category, source, body, by }) {
  await ensureKbSchema();
  const r = await pool.query(
    'INSERT INTO ticketsmodule_kb_docs (title, category, source, body, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [String(title || '').slice(0, 300) || 'Без названия', String(category || '').slice(0, 120), String(source || '').slice(0, 300), String(body || ''), String(by || '').slice(0, 120)]);
  const id = r.rows[0].id; const n = await reindexDoc(id);
  return { id, chunks: n };
}
async function updateDoc(id, { title, category, source, body }) {
  await ensureKbSchema();
  const r = await pool.query(
    `UPDATE ticketsmodule_kb_docs SET title=$1, category=$2, source=$3, body=$4, updated_at=NOW() WHERE id=$5 RETURNING id`,
    [String(title || '').slice(0, 300) || 'Без названия', String(category || '').slice(0, 120), String(source || '').slice(0, 300), String(body || ''), id]);
  if (!r.rows.length) return null;
  const n = await reindexDoc(id);
  return { id, chunks: n };
}
async function deleteDoc(id) {
  await ensureKbSchema();
  await pool.query('DELETE FROM ticketsmodule_kb_chunks WHERE doc_id=$1', [id]);
  await pool.query('DELETE FROM ticketsmodule_kb_docs WHERE id=$1', [id]);
  return { ok: true };
}

// Гибридный поиск: семантика (если включена) → полнотекст (FTS) → триграммы.
async function kbSearch(query, limit) {
  await ensureKbSchema();
  const q = String(query || '').trim(); if (!q) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 12);
  let rows = [];
  // 0) Семантический поиск по эмбеддингам (понимает смысл/перефраз), если настроено.
  try {
    if (await ensureVectorColumn()) {
      const qv = await embedText(q);
      if (qv) {
        const r0 = await pool.query(`
          SELECT doc_id, doc_title, category, chunk, 1 - (embedding <=> $1::vector) AS score
          FROM ticketsmodule_kb_chunks WHERE embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector LIMIT $2`, [vecLit(qv), lim]);
        rows = r0.rows;
      }
    }
  } catch (e) { /* откат на FTS */ }
  const seen = new Set(rows.map(x => x.chunk));
  try {
    const r = await pool.query(`
      SELECT doc_id, doc_title, category, chunk,
        ts_rank(to_tsvector('russian', chunk), plainto_tsquery('russian', $1)) AS rank
      FROM ticketsmodule_kb_chunks
      WHERE to_tsvector('russian', chunk) @@ plainto_tsquery('russian', $1)
      ORDER BY rank DESC LIMIT $2`, [q, lim]);
    for (const x of r.rows) if (!seen.has(x.chunk)) { seen.add(x.chunk); rows.push(x); }
  } catch (e) {}
  if (rows.length < Math.min(lim, 3)) {
    try {
      const r2 = await pool.query(`
        SELECT doc_id, doc_title, category, chunk, similarity(chunk, $1) AS sim
        FROM ticketsmodule_kb_chunks
        WHERE chunk % $1 ORDER BY sim DESC LIMIT $2`, [q, lim]);
      for (const x of r2.rows) if (!seen.has(x.chunk) && (x.sim == null || x.sim > 0.08)) { seen.add(x.chunk); rows.push(x); }
    } catch (e) { /* нет pg_trgm — ок */ }
  }
  return rows.slice(0, lim);
}

// Готовый блок для системного промпта агента. Пусто, если ничего не нашлось.
async function kbContext(query) {
  let hits = [];
  try { hits = await kbSearch(query, 5); } catch (e) { return ''; }
  if (!hits.length) return '';
  const body = hits.map(h => `[Источник: ${h.doc_title}${h.category ? ' · ' + h.category : ''}]\n${h.chunk}`).join('\n\n');
  return 'РЕГЛАМЕНТЫ И ИНСТРУКЦИИ КОМПАНИИ (отвечай ПО НИМ, когда вопрос об этом; '
    + 'при ответе ссылайся на источник в скобках; если в выдержках ответа нет — так и скажи, не выдумывай):\n'
    + body;
}

// Пересчитать эмбеддинги по всем документам (после включения провайдера).
async function reembedAll() {
  await ensureKbSchema();
  if (!await ensureVectorColumn()) return { ok: false, error: 'Провайдер эмбеддингов не настроен' };
  const ids = await pool.query('SELECT id FROM ticketsmodule_kb_docs');
  let done = 0; for (const r of ids.rows) { try { await reindexDoc(r.id); done++; } catch (e) {} }
  return { ok: true, docs: done };
}
function kbStatus() { return { semantic: embedConfigured(), model: EMBED.model || null, dim: EMBED.dim }; }

module.exports = { ensureKbSchema, listDocs, getDoc, addDoc, updateDoc, deleteDoc, reindexDoc, kbSearch, kbContext, reembedAll, kbStatus };

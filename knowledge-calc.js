// База знаний ЦУП (RAG): регламенты / алгоритмы / инструкции компании.
// Документ режется на фрагменты, индексируется в Postgres (полнотекст + триграммы).
// Агент (plsai-agent) достаёт релевантные фрагменты и отвечает ПО НИМ со ссылкой
// на источник. Модель не дообучается — только извлечение; правка документа сразу
// меняет ответы. Семантика (pgvector) — следующий шаг, схема к ней готова.
const { pool } = require('./auth');

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

// Гибридный поиск: полнотекст (FTS) → если мало, добираем триграммами по сходству.
async function kbSearch(query, limit) {
  await ensureKbSchema();
  const q = String(query || '').trim(); if (!q) return [];
  const lim = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 12);
  let rows = [];
  try {
    const r = await pool.query(`
      SELECT doc_id, doc_title, category, chunk,
        ts_rank(to_tsvector('russian', chunk), plainto_tsquery('russian', $1)) AS rank
      FROM ticketsmodule_kb_chunks
      WHERE to_tsvector('russian', chunk) @@ plainto_tsquery('russian', $1)
      ORDER BY rank DESC LIMIT $2`, [q, lim]);
    rows = r.rows;
  } catch (e) {}
  if (rows.length < Math.min(lim, 3)) {
    try {
      const have = new Set(rows.map(x => x.chunk));
      const r2 = await pool.query(`
        SELECT doc_id, doc_title, category, chunk, similarity(chunk, $1) AS sim
        FROM ticketsmodule_kb_chunks
        WHERE chunk % $1 ORDER BY sim DESC LIMIT $2`, [q, lim]);
      for (const x of r2.rows) if (!have.has(x.chunk) && (x.sim == null || x.sim > 0.08)) rows.push(x);
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

module.exports = { ensureKbSchema, listDocs, getDoc, addDoc, updateDoc, deleteDoc, reindexDoc, kbSearch, kbContext };

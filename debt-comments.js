// ── Комментарии с файлами по договорам Дебета ───────────────────────────────
// Привязка к договору (стабильный бизнес-ключ debt_key = номер/строка договора).
// Комментарии — в хронологическом порядке, с автором и временем; к каждому можно
// приложить несколько файлов. Новый комментарий добавляется к существующим.
const { pool } = require('./auth');
const crypto = require('crypto');

let ready = false;
async function ensureSchema() {
  if (ready) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_debt_comments (
    id SERIAL PRIMARY KEY,
    debt_key    VARCHAR(500) NOT NULL,
    contractor  VARCHAR(400),
    text        TEXT,
    author_id   INTEGER,
    author_name VARCHAR(200),
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_debt_comments_key ON ticketsmodule_debt_comments(debt_key)');
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_debt_comment_files (
    id SERIAL PRIMARY KEY,
    comment_id INTEGER REFERENCES ticketsmodule_debt_comments(id) ON DELETE CASCADE,
    filename   VARCHAR(300),
    mime       VARCHAR(120),
    size_bytes INTEGER,
    token      VARCHAR(48) UNIQUE,
    data       BYTEA
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_debt_cfiles_cid ON ticketsmodule_debt_comment_files(comment_id)');
  ready = true;
}

async function listComments(debtKey) {
  await ensureSchema();
  const { rows } = await pool.query(
    'SELECT id, text, author_name, created_at FROM ticketsmodule_debt_comments WHERE debt_key=$1 ORDER BY created_at ASC, id ASC',
    [String(debtKey || '')]);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const { rows: files } = await pool.query(
    'SELECT comment_id, filename, mime, size_bytes, token FROM ticketsmodule_debt_comment_files WHERE comment_id = ANY($1::int[]) ORDER BY id',
    [ids]);
  const byC = {};
  for (const f of files) (byC[f.comment_id] = byC[f.comment_id] || []).push({ filename: f.filename, mime: f.mime, size: f.size_bytes, token: f.token });
  return rows.map(r => ({ id: r.id, text: r.text, author: r.author_name, at: r.created_at, files: byC[r.id] || [] }));
}

const ATTACH_MAX = 15 * 1024 * 1024; // 15 МБ на файл
async function addComment({ debtKey, contractor, text, authorId, authorName, files }) {
  await ensureSchema();
  const t = String(text || '').trim();
  const fl = Array.isArray(files) ? files : [];
  if (!t && !fl.length) throw new Error('Пустой комментарий');
  const { rows } = await pool.query(
    'INSERT INTO ticketsmodule_debt_comments (debt_key, contractor, text, author_id, author_name) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
    [String(debtKey || '').slice(0, 500), String(contractor || '').slice(0, 400), t.slice(0, 4000), authorId || null, String(authorName || '').slice(0, 200)]);
  const cid = rows[0].id;
  const out = [];
  for (const f of fl) {
    const buf = Buffer.from(String(f.dataBase64 || ''), 'base64');
    if (!buf.length) continue;
    if (buf.length > ATTACH_MAX) throw new Error(`Файл «${f.filename || ''}» больше 15 МБ`);
    const token = crypto.randomBytes(18).toString('base64url');
    await pool.query(
      'INSERT INTO ticketsmodule_debt_comment_files (comment_id, filename, mime, size_bytes, token, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [cid, String(f.filename || 'file').slice(0, 300), String(f.mime || 'application/octet-stream').slice(0, 120), buf.length, token, buf]);
    out.push({ filename: f.filename, mime: f.mime, size: buf.length, token });
  }
  return { id: cid, text: t, author: authorName, at: rows[0].created_at, files: out };
}

async function getFile(token) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT filename, mime, data FROM ticketsmodule_debt_comment_files WHERE token=$1', [String(token || '')]);
  return rows[0] || null;
}

// Карта «debt_key → число комментариев» — для бейджей в таблице (только ключи с комментами).
async function counts() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT debt_key, COUNT(*)::int AS n FROM ticketsmodule_debt_comments GROUP BY debt_key');
  const m = {};
  for (const r of rows) m[r.debt_key] = r.n;
  return m;
}

module.exports = { ensureSchema, listComments, addComment, getFile, counts };

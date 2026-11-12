// Корпоративный мессенджер ЦУП (Фаза 1 MVP).
// Каналы + личные чаты, сообщения (всё в Postgres), присутствие (онлайн/отошёл/
// отсутствует), файлы (bytea в БД), @-агент на базе plsai-agent.runAgent, и
// «обучение на переписке»: при вызове агента в контекст подмешиваются релевантные
// сообщения из каналов пользователя (полнотекстовый поиск). Таблицы — свои,
// схема создаётся идемпотентно при загрузке модуля.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { pool, requireAuth } = require('../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const WRITE = []; // любой авторизованный сотрудник

let _schemaReady = false;
async function ensureMsgSchema() {
  if (_schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_channels (
      id SERIAL PRIMARY KEY,
      kind VARCHAR(10) NOT NULL DEFAULT 'group',
      title VARCHAR(200),
      dm_key VARCHAR(40),
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_at TIMESTAMPTZ DEFAULT NOW(),
      archived BOOLEAN DEFAULT false
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_dm ON ticketsmodule_msg_channels(dm_key) WHERE dm_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_members (
      channel_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role VARCHAR(10) DEFAULT 'member',
      last_read_id INTEGER DEFAULT 0,
      muted BOOLEAN DEFAULT false,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_members_user ON ticketsmodule_msg_members(user_id);
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_messages (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL,
      author_id INTEGER,
      kind VARCHAR(12) DEFAULT 'text',
      body TEXT,
      payload JSONB,
      reply_to INTEGER,
      att_name VARCHAR(300), att_type VARCHAR(120), att_size INTEGER, att_data BYTEA,
      edited_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_msg_messages_chan ON ticketsmodule_msg_messages(channel_id, id);
    CREATE INDEX IF NOT EXISTS idx_msg_messages_fts ON ticketsmodule_msg_messages USING GIN (to_tsvector('russian', coalesce(body,'')));
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_reactions (
      message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji VARCHAR(16) NOT NULL,
      PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_presence (
      user_id INTEGER PRIMARY KEY,
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      status VARCHAR(10) DEFAULT 'online'
    );
  `);
  _schemaReady = true;
}
ensureMsgSchema().catch(e => console.error('msg ensureSchema:', e.message));

const uid = req => req.user.id;
const dmKey = (a, b) => { a = +a; b = +b; return Math.min(a, b) + ':' + Math.max(a, b); };
async function isMember(channelId, userId) {
  const r = await pool.query('SELECT 1 FROM ticketsmodule_msg_members WHERE channel_id=$1 AND user_id=$2', [channelId, userId]);
  return r.rowCount > 0;
}
async function bumpPresence(userId) {
  try { await pool.query(`INSERT INTO ticketsmodule_msg_presence (user_id,last_seen_at,status) VALUES ($1,NOW(),'online')
    ON CONFLICT (user_id) DO UPDATE SET last_seen_at=NOW(), status='online'`, [userId]); } catch (e) {}
}
// Множество ФИО, кто сегодня в отпуске/командировке (для метки «отсутствует»).
async function absentNames() {
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const set = new Set();
  try {
    const iso = new Date().toISOString().slice(0, 10);
    const r = await pool.query(`SELECT name FROM ticketsmodule_portal_absences
      WHERE (from_date='' OR from_date<=$1) AND (to_date='' OR to_date>=$1)`, [iso]);
    for (const x of r.rows) if (x.name) set.add(norm(x.name));
  } catch (e) {}
  try { const trips = await require('../portal-today').smartAbsences(new Date());
    for (const t of trips) if (t.name) set.add(norm(t.name)); } catch (e) {}
  return set;
}
// Список сотрудников + статус присутствия.
async function directory() {
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const [us, pr, absent] = await Promise.all([
    pool.query('SELECT id, display_name, username, bitrix_user_id, job_title FROM ticketsmodule_users WHERE active=true ORDER BY display_name'),
    pool.query(`SELECT user_id, EXTRACT(EPOCH FROM (NOW()-last_seen_at)) AS age FROM ticketsmodule_msg_presence`),
    absentNames(),
  ]);
  const ageById = {}; for (const p of pr.rows) ageById[p.user_id] = Number(p.age);
  return us.rows.map(u => {
    const age = ageById[u.id];
    let status = 'offline';
    if (age != null && age <= 70) status = 'online';
    else if (age != null && age <= 600) status = 'away';
    if (absent.has(norm(u.display_name))) status = 'absent';
    return { id: u.id, name: u.display_name, username: u.username, bid: u.bitrix_user_id, title: u.job_title || '', status };
  });
}

// ── Бутстрап: всё для первичной отрисовки одним запросом ─────────────────────
router.get('/bootstrap', requireAuth(WRITE), async (req, res) => {
  try {
    await ensureMsgSchema(); await bumpPresence(uid(req));
    const me = { id: req.user.id, name: req.user.display_name, role: req.user.role };
    const people = await directory();
    // Мои каналы + последнее сообщение + непрочитанные.
    const ch = await pool.query(`
      SELECT c.id, c.kind, c.title, c.dm_key, c.last_at, m.last_read_id,
        (SELECT COUNT(*) FROM ticketsmodule_msg_messages x WHERE x.channel_id=c.id AND x.id > m.last_read_id AND (x.author_id IS NULL OR x.author_id <> $1) AND x.deleted_at IS NULL)::int AS unread,
        (SELECT body FROM ticketsmodule_msg_messages x WHERE x.channel_id=c.id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_body
      FROM ticketsmodule_msg_members m JOIN ticketsmodule_msg_channels c ON c.id=m.channel_id
      WHERE m.user_id=$1 AND c.archived=false ORDER BY c.last_at DESC`, [uid(req)]);
    // Для DM — имя собеседника; участники по каналам.
    const nameById = {}; people.forEach(p => { nameById[p.id] = p.name; });
    const memRows = await pool.query(`SELECT channel_id, user_id FROM ticketsmodule_msg_members WHERE channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$1)`, [uid(req)]);
    const byChan = {}; memRows.rows.forEach(r => { (byChan[r.channel_id] = byChan[r.channel_id] || []).push(r.user_id); });
    const channels = ch.rows.map(c => {
      let title = c.title, peerId = null;
      if (c.kind === 'dm') { const other = (byChan[c.id] || []).find(x => x !== uid(req)); peerId = other || null; title = nameById[other] || 'Диалог'; }
      return { id: c.id, kind: c.kind, title, peerId, unread: c.unread, lastBody: c.last_body || '', lastAt: c.last_at, members: byChan[c.id] || [] };
    });
    res.json({ ok: true, me, people, channels });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Присутствие: пинг + снимок (для поллинга) ────────────────────────────────
router.post('/ping', requireAuth(WRITE), async (req, res) => {
  try { await bumpPresence(uid(req)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Поллинг: новые сообщения в моих каналах после since + присутствие ─────────
router.get('/poll', requireAuth(WRITE), async (req, res) => {
  try {
    await bumpPresence(uid(req));
    const since = parseInt(req.query.since, 10) || 0;
    const msgs = await pool.query(`
      SELECT m.id, m.channel_id, m.author_id, m.kind, m.body, m.payload, m.reply_to,
             m.att_name, m.att_type, m.att_size, m.created_at, u.display_name AS author_name
      FROM ticketsmodule_msg_messages m
      LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
      WHERE m.id > $1 AND m.deleted_at IS NULL
        AND m.channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$2)
      ORDER BY m.id ASC LIMIT 200`, [since, uid(req)]);
    const people = await directory();
    res.json({ ok: true, messages: msgs.rows, people });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── История канала ───────────────────────────────────────────────────────────
router.get('/channels/:id(\\d+)/messages', requireAuth(WRITE), async (req, res) => {
  try {
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).json({ ok: false, error: 'Нет доступа к чату' });
    const before = parseInt(req.query.before, 10) || 0;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const where = before ? 'AND m.id < $3' : '';
    const params = before ? [cid, limit, before] : [cid, limit];
    const r = await pool.query(`
      SELECT m.id, m.channel_id, m.author_id, m.kind, m.body, m.payload, m.reply_to,
             m.att_name, m.att_type, m.att_size, m.created_at, u.display_name AS author_name
      FROM ticketsmodule_msg_messages m
      LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
      WHERE m.channel_id=$1 AND m.deleted_at IS NULL ${where}
      ORDER BY m.id DESC LIMIT $2`, params);
    // реакции
    const ids = r.rows.map(x => x.id);
    let reactions = {};
    if (ids.length) {
      const rr = await pool.query('SELECT message_id, emoji, COUNT(*)::int n, array_agg(user_id) users FROM ticketsmodule_msg_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji', [ids]);
      rr.rows.forEach(x => { (reactions[x.message_id] = reactions[x.message_id] || []).push({ emoji: x.emoji, n: x.n, users: x.users }); });
    }
    res.json({ ok: true, messages: r.rows.reverse(), reactions });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Отправка сообщения (+ @-агент) ───────────────────────────────────────────
const MENTION = /(^|\s)@(аи|ии|ai|агент|agent)\b/i;
router.post('/channels/:id(\\d+)/messages', requireAuth(WRITE), express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).json({ ok: false, error: 'Нет доступа к чату' });
    const body = String((req.body && req.body.body) || '').trim();
    const replyTo = (req.body && +req.body.reply_to) || null;
    if (!body) return res.status(400).json({ ok: false, error: 'Пустое сообщение' });
    const ins = await pool.query(
      `INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body, reply_to) VALUES ($1,$2,'text',$3,$4) RETURNING id, created_at`,
      [cid, uid(req), body, replyTo]);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    await pool.query('UPDATE ticketsmodule_msg_members SET last_read_id=$1 WHERE channel_id=$2 AND user_id=$3', [ins.rows[0].id, cid, uid(req)]);
    const msg = { id: ins.rows[0].id, channel_id: cid, author_id: uid(req), kind: 'text', body, reply_to: replyTo, created_at: ins.rows[0].created_at, author_name: req.user.display_name };
    // Вызов агента — в фоне, ответ прилетит поллингом.
    if (MENTION.test(body)) runAgentInChannel(cid, req.user, body).catch(e => console.error('msg agent:', e.message));
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Агент отвечает в канал: подмешиваем релевантную переписку (обучение на текстах),
// затем runAgent, затем постим ответ как сообщение kind='ai'.
async function runAgentInChannel(cid, user, rawBody) {
  const q = rawBody.replace(MENTION, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return;
  let context = '';
  try {
    const rel = await pool.query(`
      SELECT m.body, u.display_name AS who
      FROM ticketsmodule_msg_messages m LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
      WHERE m.deleted_at IS NULL AND m.kind='text' AND char_length(m.body) > 2
        AND m.channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$1)
        AND to_tsvector('russian', coalesce(m.body,'')) @@ plainto_tsquery('russian', $2)
      ORDER BY m.id DESC LIMIT 6`, [user.id, q]);
    if (rel.rows.length) context = 'Контекст из рабочей переписки:\n' + rel.rows.map(r => (r.who || 'сотрудник') + ': ' + r.body).join('\n') + '\n\n';
  } catch (e) {}
  let answer = '', payload = null;
  try {
    const { runAgent } = require('../plsai-agent');
    const out = await runAgent(context + 'Вопрос: ' + q, user);
    answer = (out && out.answer) || 'Не удалось сформировать ответ.';
    if (out && (out.table || out.steps || out.exportToken)) payload = { table: out.table || null, steps: out.steps || null, exportToken: out.exportToken || null };
  } catch (e) { answer = 'Агент временно недоступен: ' + e.message; }
  const ins = await pool.query(
    `INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body, payload) VALUES ($1,NULL,'ai',$2,$3) RETURNING id`,
    [cid, answer, payload ? JSON.stringify(payload) : null]);
  await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
  return ins.rows[0].id;
}

// ── Файл как сообщение ───────────────────────────────────────────────────────
router.post('/channels/:id(\\d+)/file', requireAuth(WRITE), upload.single('file'), async (req, res) => {
  try {
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).json({ ok: false, error: 'Нет доступа к чату' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Файл не передан' });
    const caption = String((req.body && req.body.caption) || '').trim();
    const ins = await pool.query(
      `INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body, att_name, att_type, att_size, att_data)
       VALUES ($1,$2,'file',$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [cid, uid(req), caption, req.file.originalname.slice(0, 300), req.file.mimetype, req.file.size, req.file.buffer]);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    res.json({ ok: true, id: ins.rows[0].id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/file/:mid(\\d+)', requireAuth(WRITE), async (req, res) => {
  try {
    const r = await pool.query('SELECT channel_id, att_name, att_type, att_data FROM ticketsmodule_msg_messages WHERE id=$1', [+req.params.mid]);
    const m = r.rows[0]; if (!m || !m.att_data) return res.status(404).send('Нет файла');
    if (!(await isMember(m.channel_id, uid(req)))) return res.status(403).send('Нет доступа');
    res.setHeader('Content-Type', m.att_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(m.att_name || 'file'));
    res.send(m.att_data);
  } catch (e) { res.status(500).send(e.message); }
});

// ── Диалог 1:1 (создать или открыть) ─────────────────────────────────────────
router.post('/dm', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const other = +(req.body && req.body.userId);
    if (!other || other === uid(req)) return res.status(400).json({ ok: false, error: 'Неверный собеседник' });
    const key = dmKey(uid(req), other);
    let ch = await pool.query('SELECT id FROM ticketsmodule_msg_channels WHERE dm_key=$1', [key]);
    let cid;
    if (ch.rows.length) cid = ch.rows[0].id;
    else {
      const c = await pool.query(`INSERT INTO ticketsmodule_msg_channels (kind, dm_key, created_by) VALUES ('dm',$1,$2) RETURNING id`, [key, uid(req)]);
      cid = c.rows[0].id;
      await pool.query(`INSERT INTO ticketsmodule_msg_members (channel_id, user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [cid, uid(req), other]);
    }
    res.json({ ok: true, channelId: cid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Групповой канал ──────────────────────────────────────────────────────────
router.post('/channels', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const title = String((req.body && req.body.title) || '').trim().slice(0, 200);
    if (!title) return res.status(400).json({ ok: false, error: 'Укажите название канала' });
    const members = Array.from(new Set([uid(req), ...((req.body && req.body.memberIds) || []).map(Number).filter(Boolean)]));
    const c = await pool.query(`INSERT INTO ticketsmodule_msg_channels (kind, title, created_by) VALUES ('group',$1,$2) RETURNING id`, [title, uid(req)]);
    const cid = c.rows[0].id;
    const vals = members.map((_, i) => `($1,$${i + 2},${members[i] === uid(req) ? "'admin'" : "'member'"})`).join(',');
    await pool.query(`INSERT INTO ticketsmodule_msg_members (channel_id, user_id, role) VALUES ${vals} ON CONFLICT DO NOTHING`, [cid, ...members]);
    await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'system',$2)`, [cid, 'Канал создан: ' + title]);
    res.json({ ok: true, channelId: cid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Прочитано / реакция ──────────────────────────────────────────────────────
router.post('/read', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const cid = +(req.body && req.body.channelId), lastId = +(req.body && req.body.lastId) || 0;
    if (!cid) return res.status(400).json({ ok: false, error: 'channelId' });
    await pool.query('UPDATE ticketsmodule_msg_members SET last_read_id=GREATEST(last_read_id,$1) WHERE channel_id=$2 AND user_id=$3', [lastId, cid, uid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/react', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const mid = +(req.body && req.body.messageId), emoji = String((req.body && req.body.emoji) || '').slice(0, 16);
    if (!mid || !emoji) return res.status(400).json({ ok: false, error: 'messageId/emoji' });
    const ex = await pool.query('SELECT 1 FROM ticketsmodule_msg_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [mid, uid(req), emoji]);
    if (ex.rowCount) await pool.query('DELETE FROM ticketsmodule_msg_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3', [mid, uid(req), emoji]);
    else await pool.query('INSERT INTO ticketsmodule_msg_reactions (message_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [mid, uid(req), emoji]);
    res.json({ ok: true, on: !ex.rowCount });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Поиск по переписке ───────────────────────────────────────────────────────
router.get('/search', requireAuth(WRITE), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim(); if (!q) return res.json({ ok: true, results: [] });
    const r = await pool.query(`
      SELECT m.id, m.channel_id, m.body, m.created_at, u.display_name AS author_name, c.title, c.kind
      FROM ticketsmodule_msg_messages m
      LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
      JOIN ticketsmodule_msg_channels c ON c.id=m.channel_id
      WHERE m.deleted_at IS NULL
        AND m.channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$1)
        AND to_tsvector('russian', coalesce(m.body,'')) @@ plainto_tsquery('russian', $2)
      ORDER BY m.id DESC LIMIT 40`, [uid(req), q]);
    res.json({ ok: true, results: r.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

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
const storage = require('../storage-lib'); // Supabase Storage (объектное хранилище)

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
    -- Отделы (задаёт админ): именованные группы сотрудников для тега @отдел.
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_teams (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_team_name ON ticketsmodule_msg_teams(lower(name));
    CREATE TABLE IF NOT EXISTS ticketsmodule_msg_team_members (
      team_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      PRIMARY KEY (team_id, user_id)
    );
  `);
  // Доставленность/прочтение + роли/блокировка/упоминания. Каждый ALTER независимо.
  for (const col of [
    'last_delivered_id INTEGER DEFAULT 0', 'last_read_at TIMESTAMPTZ', 'last_delivered_at TIMESTAMPTZ'
  ]) {
    try { await pool.query(`ALTER TABLE ticketsmodule_msg_members ADD COLUMN IF NOT EXISTS ${col}`); }
    catch (e) { console.error('msg ALTER members ' + col + ':', e.message); }
  }
  try { await pool.query(`ALTER TABLE ticketsmodule_msg_channels ADD COLUMN IF NOT EXISTS locked BOOLEAN DEFAULT false`); }
  catch (e) { console.error('msg ALTER channels locked:', e.message); }
  try { await pool.query(`ALTER TABLE ticketsmodule_msg_messages ADD COLUMN IF NOT EXISTS mentions INTEGER[]`); }
  catch (e) { console.error('msg ALTER messages mentions:', e.message); }
  // Ключ объекта в Storage (если файл вынесен из БД в объектное хранилище).
  try { await pool.query(`ALTER TABLE ticketsmodule_msg_messages ADD COLUMN IF NOT EXISTS att_key VARCHAR(400)`); }
  catch (e) { console.error('msg ALTER messages att_key:', e.message); }
  _schemaReady = true;
}
ensureMsgSchema().catch(e => console.error('msg ensureSchema:', e.message));

// Гарантированно досоздать колонки доставки/прочтения (самолечение). Вызывается,
// если какой-то запрос упал из-за отсутствующей колонки — тогда досоздаём и
// повторяем. Дёшево и идемпотентно.
async function ensureMsgColumns() {
  for (const col of ['last_delivered_id INTEGER DEFAULT 0', 'last_read_at TIMESTAMPTZ', 'last_delivered_at TIMESTAMPTZ']) {
    try { await pool.query(`ALTER TABLE ticketsmodule_msg_members ADD COLUMN IF NOT EXISTS ${col}`); } catch (e) {}
  }
}

// Пометить всё доставленным текущему пользователю (он онлайн и получил снимок).
async function markDeliveredAll(userId) {
  try {
    await pool.query(`UPDATE ticketsmodule_msg_members mm
      SET last_delivered_id = GREATEST(mm.last_delivered_id,
            COALESCE((SELECT MAX(x.id) FROM ticketsmodule_msg_messages x WHERE x.channel_id=mm.channel_id AND x.deleted_at IS NULL),0)),
          last_delivered_at = CASE WHEN mm.last_delivered_id <
            COALESCE((SELECT MAX(x.id) FROM ticketsmodule_msg_messages x WHERE x.channel_id=mm.channel_id AND x.deleted_at IS NULL),0)
            THEN NOW() ELSE mm.last_delivered_at END
      WHERE mm.user_id=$1`, [userId]);
  } catch (e) { ensureMsgColumns().catch(() => {}); }
}
// Указатели прочтения/доставки по участникам моих каналов (для «галочек»).
// Доставку усиливаем присутствием: если получатель сейчас онлайн (свежий пинг),
// считаем доставленным до последнего сообщения канала — галочка «доставлено»
// появляется сразу, не дожидаясь его опроса.
async function membersPointers(userId, onlyChannel, _retried) {
  // ВАЖНО: параметры нумеруем последовательно ($1) в ОБОИХ ветках. Раньше ветка
  // одного канала передавала [userId, onlyChannel], а ссылалась только на $2 —
  // Postgres ругался на число параметров, запрос падал, и клиент получал пустых
  // участников (ломались галочки). Теперь $1 используется всегда.
  const params = onlyChannel ? [onlyChannel] : [userId];
  const where = onlyChannel
    ? `m.channel_id=$1`
    : `m.channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$1)`;
  let r;
  try {
    r = await pool.query(`
      SELECT m.channel_id, m.user_id, m.last_read_id, m.last_delivered_id, m.last_read_at, m.last_delivered_at,
        COALESCE(EXTRACT(EPOCH FROM (NOW()-p.last_seen_at)), 999999) AS pres_age,
        COALESCE((SELECT MAX(x.id) FROM ticketsmodule_msg_messages x WHERE x.channel_id=m.channel_id AND x.deleted_at IS NULL), 0) AS maxid
      FROM ticketsmodule_msg_members m
      LEFT JOIN ticketsmodule_msg_presence p ON p.user_id = m.user_id
      WHERE ${where}`, params);
  } catch (e) {
    // Самолечение: не хватает колонки доставки/прочтения — досоздаём и повторяем.
    if (!_retried) { await ensureMsgColumns(); return membersPointers(userId, onlyChannel, true); }
    // Запасной путь: если колонки доставки так и недоступны — работаем на гарантированной
    // last_read_id + присутствии (доставка по онлайну). Галочки не отваливаются.
    const rb = await pool.query(`
      SELECT m.channel_id, m.user_id, m.last_read_id,
        COALESCE(EXTRACT(EPOCH FROM (NOW()-p.last_seen_at)), 999999) AS pres_age,
        COALESCE((SELECT MAX(x.id) FROM ticketsmodule_msg_messages x WHERE x.channel_id=m.channel_id AND x.deleted_at IS NULL), 0) AS maxid
      FROM ticketsmodule_msg_members m
      LEFT JOIN ticketsmodule_msg_presence p ON p.user_id = m.user_id
      WHERE ${where}`, params);
    return rb.rows.map(x => {
      let d = 0, da = null;
      if (Number(x.pres_age) <= 120) { d = Number(x.maxid) || 0; da = new Date().toISOString(); }
      return { c: x.channel_id, u: x.user_id, r: x.last_read_id || 0, d, ra: null, da };
    });
  }
  return r.rows.map(x => {
    let d = x.last_delivered_id || 0;
    let da = x.last_delivered_at || null;
    if (Number(x.pres_age) <= 120) { const mx = Number(x.maxid) || 0; if (mx > d) { d = mx; da = da || new Date().toISOString(); } }
    return { c: x.channel_id, u: x.user_id, r: x.last_read_id || 0, d, ra: x.last_read_at || null, da };
  });
}

const uid = req => req.user.id;
const dmKey = (a, b) => { a = +a; b = +b; return Math.min(a, b) + ':' + Math.max(a, b); };
async function isMember(channelId, userId) {
  const r = await pool.query('SELECT 1 FROM ticketsmodule_msg_members WHERE channel_id=$1 AND user_id=$2', [channelId, userId]);
  return r.rowCount > 0;
}
// Админ приложения (admin/superadmin) — управляет отделами и любыми группами.
function isAppAdmin(user) { return user && (user.role === 'admin' || user.role === 'superadmin'); }
// Админ конкретного канала: роль admin в канале ИЛИ админ приложения.
async function isChannelAdmin(channelId, user) {
  if (isAppAdmin(user)) return true;
  const r = await pool.query(`SELECT role FROM ticketsmodule_msg_members WHERE channel_id=$1 AND user_id=$2`, [channelId, user.id]);
  return r.rows[0] && r.rows[0].role === 'admin';
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
  // Второй сигнал присутствия — общая активность по мониторингу (любой запрос
  // пользователя, включая опрос бейджа /api/notify/pending-count раз в 60 сек).
  // Берём более свежий из двух, чтобы онлайн совпадал со страницей «Мониторинг»
  // и не зависел от того, открыт ли именно экран мессенджера.
  const monIdle = {};
  try { for (const a of require('../monitoring').onlineList()) if (a && a.id != null) monIdle[a.id] = Number(a.idleSec); } catch (e) {}
  return us.rows.map(u => {
    const pAge = ageById[u.id];
    const mAge = monIdle[u.id];
    let age = null;
    if (pAge != null) age = pAge;
    if (mAge != null) age = (age == null) ? mAge : Math.min(age, mAge);
    let status = 'offline';
    if (age != null && age <= 90) status = 'online';
    else if (age != null && age <= 600) status = 'away';
    if (absent.has(norm(u.display_name))) status = 'absent';
    return { id: u.id, name: u.display_name, username: u.username, bid: u.bitrix_user_id, title: u.job_title || '', status };
  });
}

// Персональный чат с ИИ-агентом (как диалог с ботом). Один на пользователя,
// закреплён вверху; в нём каждое сообщение уходит агенту без @-упоминания.
async function ensureAgentChannel(userId) {
  const key = 'ai:' + userId;
  const ex = await pool.query('SELECT id FROM ticketsmodule_msg_channels WHERE dm_key=$1', [key]);
  if (ex.rows.length) return ex.rows[0].id;
  const c = await pool.query(`INSERT INTO ticketsmodule_msg_channels (kind, title, dm_key, created_by) VALUES ('ai','Агент ЦУП',$1,$2) RETURNING id`, [key, userId]);
  const cid = c.rows[0].id;
  await pool.query(`INSERT INTO ticketsmodule_msg_members (channel_id, user_id, role) VALUES ($1,$2,'admin') ON CONFLICT DO NOTHING`, [cid, userId]);
  await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'ai',$2)`,
    [cid, 'Здравствуйте! Я агент ЦУП. Спрашивайте о командировках, компаниях, задачах, закупках и цифрах — отвечу по данным системы. Пишите обычным языком, тут @аи указывать не нужно.']);
  await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
  return cid;
}

// Список отделов с составом (для автодополнения @отдел и управления).
async function listTeams() {
  const t = await pool.query('SELECT id, name FROM ticketsmodule_msg_teams ORDER BY lower(name)');
  if (!t.rows.length) return [];
  const tm = await pool.query('SELECT team_id, user_id FROM ticketsmodule_msg_team_members');
  const by = {}; tm.rows.forEach(r => { (by[r.team_id] = by[r.team_id] || []).push(r.user_id); });
  return t.rows.map(x => ({ id: x.id, name: x.name, members: by[x.id] || [] }));
}

// ── Бутстрап: всё для первичной отрисовки одним запросом ─────────────────────
router.get('/bootstrap', requireAuth(WRITE), async (req, res) => {
  try {
    await ensureMsgSchema(); await bumpPresence(uid(req)); await markDeliveredAll(uid(req));
    try { await ensureAgentChannel(uid(req)); } catch (e) { console.error('msg agent channel:', e.message); }
    const me = { id: req.user.id, name: req.user.display_name, role: req.user.role };
    const people = await directory();
    // Мои каналы + последнее сообщение + непрочитанные.
    const ch = await pool.query(`
      SELECT c.id, c.kind, c.title, c.dm_key, c.last_at, c.locked, m.last_read_id, m.role AS my_role,
        (CASE WHEN c.kind='ai' THEN 0 ELSE (SELECT COUNT(*) FROM ticketsmodule_msg_messages x WHERE x.channel_id=c.id AND x.id > m.last_read_id AND x.author_id IS NOT NULL AND x.author_id <> $1 AND x.deleted_at IS NULL) END)::int AS unread,
        (SELECT body FROM ticketsmodule_msg_messages x WHERE x.channel_id=c.id AND x.deleted_at IS NULL ORDER BY x.id DESC LIMIT 1) AS last_body
      FROM ticketsmodule_msg_members m JOIN ticketsmodule_msg_channels c ON c.id=m.channel_id
      WHERE m.user_id=$1 AND c.archived=false ORDER BY c.last_at DESC`, [uid(req)]);
    // Для DM — имя собеседника; участники по каналам.
    const nameById = {}; people.forEach(p => { nameById[p.id] = p.name; });
    const memRows = await pool.query(`SELECT channel_id, user_id FROM ticketsmodule_msg_members WHERE channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$1)`, [uid(req)]);
    const byChan = {}; memRows.rows.forEach(r => { (byChan[r.channel_id] = byChan[r.channel_id] || []).push(r.user_id); });
    const appAdmin = isAppAdmin(req.user);
    const channels = ch.rows.map(c => {
      let title = c.title, peerId = null;
      if (c.kind === 'dm') { const other = (byChan[c.id] || []).find(x => x !== uid(req)); peerId = other || null; title = nameById[other] || 'Диалог'; }
      const iAmAdmin = appAdmin || c.my_role === 'admin';
      return { id: c.id, kind: c.kind, title, peerId, unread: c.unread, lastBody: c.last_body || '', lastAt: c.last_at,
        members: byChan[c.id] || [], locked: !!c.locked, myRole: c.my_role || 'member', iAmAdmin };
    });
    let receipts = []; try { receipts = await membersPointers(uid(req)); } catch (e) { console.error('msg receipts boot:', e.message); }
    let teams = []; try { teams = await listTeams(); } catch (e) { console.error('msg teams boot:', e.message); }
    res.json({ ok: true, me, people, channels, receipts, teams, appAdmin });
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
    await bumpPresence(uid(req)); await markDeliveredAll(uid(req));
    const since = parseInt(req.query.since, 10) || 0;
    const msgs = await pool.query(`
      SELECT m.id, m.channel_id, m.author_id, m.kind, m.body, m.payload, m.reply_to,
             m.att_name, m.att_type, m.att_size, m.mentions, m.created_at, u.display_name AS author_name
      FROM ticketsmodule_msg_messages m
      LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
      WHERE m.id > $1 AND m.deleted_at IS NULL
        AND m.channel_id IN (SELECT channel_id FROM ticketsmodule_msg_members WHERE user_id=$2)
      ORDER BY m.id ASC LIMIT 200`, [since, uid(req)]);
    const people = await directory();
    let receipts = []; try { receipts = await membersPointers(uid(req)); } catch (e) { console.error('msg receipts poll:', e.message); }
    res.json({ ok: true, messages: msgs.rows, people, receipts });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── История канала ───────────────────────────────────────────────────────────
router.get('/channels/:id(\\d+)/messages', requireAuth(WRITE), async (req, res) => {
  try {
    await ensureMsgSchema();
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).json({ ok: false, error: 'Нет доступа к чату' });
    const before = parseInt(req.query.before, 10) || 0;
    // Открытие чата (свежая страница, не прокрутка истории) = прочитано.
    // Отмечаем на сервере, чтобы счётчик непрочитанных надёжно гас при чтении,
    // не завися только от клиентского вызова /read.
    if (!before) {
      // Критично: last_read_id — отдельным запросом (сохраняется всегда).
      try {
        await pool.query(`UPDATE ticketsmodule_msg_members mm
          SET last_read_id = GREATEST(mm.last_read_id, COALESCE((SELECT MAX(x.id) FROM ticketsmodule_msg_messages x WHERE x.channel_id=mm.channel_id AND x.deleted_at IS NULL),0))
          WHERE mm.channel_id=$1 AND mm.user_id=$2`, [cid, uid(req)]);
      } catch (e) { /* не критично для отдачи сообщений */ }
      try { await pool.query(`UPDATE ticketsmodule_msg_members SET last_read_at = NOW() WHERE channel_id=$1 AND user_id=$2`, [cid, uid(req)]); }
      catch (e) { ensureMsgColumns().catch(() => {}); }
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const where = before ? 'AND m.id < $3' : '';
    const params = before ? [cid, limit, before] : [cid, limit];
    const r = await pool.query(`
      SELECT m.id, m.channel_id, m.author_id, m.kind, m.body, m.payload, m.reply_to,
             m.att_name, m.att_type, m.att_size, m.mentions, m.created_at, u.display_name AS author_name
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
    // Участники и квитанции — НЕЗАВИСИМО: даже если квитанции упадут, список
    // участников должен прийти (иначе на клиенте ломаются галочки).
    let receipts = [], members = [];
    try { const mem = await pool.query('SELECT user_id FROM ticketsmodule_msg_members WHERE channel_id=$1', [cid]); members = mem.rows.map(x => x.user_id); } catch (e) { console.error('msg members:', e.message); }
    try { receipts = await membersPointers(uid(req), cid); } catch (e) { console.error('msg receipts:', e.message); }
    let locked = false, iAmAdmin = false;
    try { const cc = await pool.query('SELECT locked FROM ticketsmodule_msg_channels WHERE id=$1', [cid]); locked = !!(cc.rows[0] && cc.rows[0].locked); iAmAdmin = await isChannelAdmin(cid, req.user); } catch (e) {}
    res.json({ ok: true, messages: r.rows.reverse(), reactions, receipts, members, locked, iAmAdmin });
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
    const chk = await pool.query('SELECT kind, locked FROM ticketsmodule_msg_channels WHERE id=$1', [cid]);
    const isAi = chk.rows[0] && chk.rows[0].kind === 'ai';
    // Закрытый канал: писать могут только админы.
    if (chk.rows[0] && chk.rows[0].locked && !(await isChannelAdmin(cid, req.user)))
      return res.status(403).json({ ok: false, error: 'Канал закрыт: писать могут только админы' });
    // Упоминания (клиент резолвит из автодополнения: люди + отделы). Только участники канала.
    let mentions = Array.from(new Set(((req.body && req.body.mentions) || []).map(Number).filter(Boolean)));
    if (mentions.length) {
      const mm = await pool.query('SELECT user_id FROM ticketsmodule_msg_members WHERE channel_id=$1', [cid]);
      const inCh = new Set(mm.rows.map(x => x.user_id));
      mentions = mentions.filter(u => inCh.has(u) && u !== uid(req));
    }
    const ins = await pool.query(
      `INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body, reply_to, mentions) VALUES ($1,$2,'text',$3,$4,$5) RETURNING id, created_at`,
      [cid, uid(req), body, replyTo, mentions.length ? mentions : null]);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    await pool.query('UPDATE ticketsmodule_msg_members SET last_read_id=$1 WHERE channel_id=$2 AND user_id=$3', [ins.rows[0].id, cid, uid(req)]);
    const msg = { id: ins.rows[0].id, channel_id: cid, author_id: uid(req), kind: 'text', body, reply_to: replyTo, mentions: mentions.length ? mentions : null, created_at: ins.rows[0].created_at, author_name: req.user.display_name };
    pushNewMessage(cid, uid(req), req.user.display_name, body).catch(() => {});
    // Личный чат с агентом — отвечаем на каждое сообщение; в обычных каналах — по @-упоминанию.
    if (isAi || MENTION.test(body)) runAgentInChannel(cid, req.user, body).catch(e => console.error('msg agent:', e.message));
    res.json({ ok: true, message: msg });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Пуш-уведомление о новом сообщении участникам канала, которые СЕЙЧАС не в сети
// (онлайн увидят через поллинг). Требует настроенного web-push (VAPID) и подписки.
async function pushNewMessage(cid, authorUserId, authorName, body) {
  try {
    const push = require('../push');
    const r = await pool.query(`
      SELECT u.bitrix_user_id AS bid, EXTRACT(EPOCH FROM (NOW()-p.last_seen_at)) AS age
      FROM ticketsmodule_msg_members m
      JOIN ticketsmodule_users u ON u.id = m.user_id
      LEFT JOIN ticketsmodule_msg_presence p ON p.user_id = m.user_id
      WHERE m.channel_id=$1 AND m.user_id <> $2 AND u.bitrix_user_id IS NOT NULL AND COALESCE(m.muted,false)=false`,
      [cid, authorUserId || 0]);
    if (!r.rows.length) return;
    const ch = await pool.query('SELECT kind, title FROM ticketsmodule_msg_channels WHERE id=$1', [cid]);
    const c = ch.rows[0] || {};
    const title = (c.kind === 'group' && c.title) ? (authorName + ' · ' + c.title) : (authorName || 'Сообщение');
    const text = String(body || '').replace(/\s+/g, ' ').slice(0, 140) || 'новое сообщение';
    const payload = { type: 'msg', channelId: cid, notify: { title: title.slice(0, 80), body: text }, url: '/messenger.html' };
    for (const row of r.rows) {
      if (row.age != null && Number(row.age) <= 70) continue; // сейчас в сети — пуш не нужен
      push.sendToUser(row.bid, payload).catch(() => {});
    }
  } catch (e) { /* пуш — best-effort */ }
}

// Агент отвечает в канал: подмешиваем релевантную переписку (обучение на текстах),
// затем runAgent, затем постим ответ как сообщение kind='ai'.
async function runAgentInChannel(cid, user, rawBody) {
  const q = rawBody.replace(MENTION, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return;
  // Короткая/неполная реплика («за 10», «а по второму», «да, покажи») понимается
  // только из контекста — тогда (и ТОЛЬКО тогда) подмешиваем недавнюю историю.
  // Полноценный вопрос отвечаем «с чистого листа», без истории — иначе сильная
  // модель залипает на старую тему из прошлых сообщений.
  const words = q.split(/\s+/).filter(Boolean).length;
  const shortRef = /^(а|и|за|по|ещё|еще|да|нет|теперь|тогда|их|те|эти|этот|эту|эт|ок)\b/i.test(q) || /^[\d\s.,-]+$/.test(q);
  const isFollowup = words <= 4 || (words <= 6 && shortRef);
  let prompt = q;
  if (isFollowup) {
    let history = '';
    try {
      const h = await pool.query(`
        SELECT m.author_id, m.kind, m.body, u.display_name AS who
        FROM ticketsmodule_msg_messages m LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
        WHERE m.channel_id=$1 AND m.deleted_at IS NULL AND m.kind IN ('text','ai')
          AND m.body IS NOT NULL AND char_length(m.body) > 0
        ORDER BY m.id DESC LIMIT 8`, [cid]);
      const rows = h.rows.reverse();
      if (rows.length && rows[rows.length - 1].kind === 'text' && (rows[rows.length - 1].body || '').trim() === rawBody.trim()) rows.pop();
      history = rows.map(r => (r.kind === 'ai' ? 'Агент' : (r.who || 'Сотрудник')) + ': ' + String(r.body || '').replace(/\s+/g, ' ').slice(0, 400)).join('\n');
    } catch (e) {}
    if (history) {
      prompt = 'Это продолжение диалога. Ниже недавняя переписка — используй её, чтобы понять короткую реплику сотрудника '
        + '(например «за 10» = та же тема, но за 10-е число; «а по второму» = про второй пункт из прошлого ответа). '
        + 'Не переспрашивай, если смысл ясен из контекста.\n\nПереписка:\n' + history + '\n\nРеплика сотрудника: ' + q;
    }
  }
  let answer = '', payload = null;
  try {
    const { runAgent } = require('../plsai-agent');
    const out = await runAgent(prompt, user);
    answer = (out && out.answer) || 'Не удалось сформировать ответ.';
    if (out && (out.table || out.steps || out.exportToken)) payload = { table: out.table || null, steps: out.steps || null, exportToken: out.exportToken || null };
  } catch (e) { answer = 'Агент временно недоступен: ' + e.message; }
  const ins = await pool.query(
    `INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body, payload) VALUES ($1,NULL,'ai',$2,$3) RETURNING id`,
    [cid, answer, payload ? JSON.stringify(payload) : null]);
  await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
  pushNewMessage(cid, 0, 'Агент ЦУП', answer).catch(() => {});
  return ins.rows[0].id;
}

// ── Файл как сообщение ───────────────────────────────────────────────────────
// По умолчанию файл уходит в объектное хранилище (Supabase Storage, префикс
// ключа «messenger/»). Если хранилище не настроено — безопасный откат в БД (bytea).
router.post('/channels/:id(\\d+)/file', requireAuth(WRITE), upload.single('file'), async (req, res) => {
  try {
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).json({ ok: false, error: 'Нет доступа к чату' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Файл не передан' });
    const caption = String((req.body && req.body.caption) || '').trim();
    // Имя файла: multer отдаёт latin1 → перекодируем в utf8 (кириллица).
    let orig = req.file.originalname || 'file';
    try { orig = Buffer.from(orig, 'latin1').toString('utf8'); } catch (_) {}
    orig = orig.slice(0, 300);
    const ext = ((orig.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0] || '').toLowerCase();
    let attKey = null, attData = null;
    if (storage.configured()) {
      try {
        const rand = Math.random().toString(16).slice(2, 8);
        attKey = `messenger/${cid}/${Date.now()}-${rand}${ext}`;
        await storage.upload(attKey, req.file.buffer, req.file.mimetype);
      } catch (e) { console.error('msg storage upload, откат в БД:', e.message); attKey = null; attData = req.file.buffer; }
    } else { attData = req.file.buffer; }
    const ins = await pool.query(
      `INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body, att_name, att_type, att_size, att_data, att_key)
       VALUES ($1,$2,'file',$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [cid, uid(req), caption, orig, req.file.mimetype, req.file.size, attData, attKey]);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    pushNewMessage(cid, uid(req), req.user.display_name, '📄 ' + (caption || orig)).catch(() => {});
    res.json({ ok: true, id: ins.rows[0].id });
    // ── Голосовое → распознавание речи (и ответ агента в чате с агентом) ──────
    // Ответ уже отправлен клиенту; расшифровка идёт в фоне, результат придёт поллингом.
    const isAudio = /^audio\//.test(req.file.mimetype || '') || /\.(webm|ogg|m4a|mp3|wav)$/i.test(orig);
    if (isAudio) {
      (async () => {
        try {
          const stt = require('../stt-lib');
          if (!stt.configured()) return;
          const chk = await pool.query('SELECT kind FROM ticketsmodule_msg_channels WHERE id=$1', [cid]);
          const isAiChan = chk.rows[0] && chk.rows[0].kind === 'ai';
          // В чате с агентом распознаём всегда; в обычных чатах — только если включено STT_ALL_CHATS.
          if (!isAiChan && !process.env.STT_ALL_CHATS) return;
          const text = await stt.transcribe(req.file.buffer, req.file.mimetype, orig);
          if (!text) return;
          // Показать расшифровку в самом голосовом сообщении (под плеером).
          await pool.query('UPDATE ticketsmodule_msg_messages SET body=$1 WHERE id=$2', ['🎤 ' + text, ins.rows[0].id]);
          // В чате с агентом — передаём распознанный текст агенту, он отвечает.
          if (isAiChan) await runAgentInChannel(cid, req.user, text);
        } catch (e) { console.error('voice stt/agent:', e.message); }
      })();
    }
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/file/:mid(\\d+)', requireAuth(WRITE), async (req, res) => {
  try {
    const r = await pool.query('SELECT channel_id, att_name, att_type, att_data, att_key FROM ticketsmodule_msg_messages WHERE id=$1', [+req.params.mid]);
    const m = r.rows[0]; if (!m || (!m.att_data && !m.att_key)) return res.status(404).send('Нет файла');
    if (!(await isMember(m.channel_id, uid(req)))) return res.status(403).send('Нет доступа');
    if (m.att_key) { // файл в объектном хранилище — короткоживущая подписанная ссылка
      let url = await storage.signedUrl(m.att_key, 300);
      url += (url.includes('?') ? '&' : '?') + 'download=' + encodeURIComponent(m.att_name || 'file');
      return res.redirect(url);
    }
    res.setHeader('Content-Type', m.att_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(m.att_name || 'file'));
    res.send(m.att_data);
  } catch (e) { res.status(500).send(e.message); }
});
// Статус хранилища + сколько файлов ещё в БД (для миграции) — только админ.
router.get('/files/status', requireAuth(WRITE), async (req, res) => {
  try {
    if (!isAppAdmin(req.user)) return res.status(403).json({ ok: false, error: 'Только админ' });
    const inDb = await pool.query(`SELECT COUNT(*)::int n, COALESCE(SUM(att_size),0)::bigint bytes FROM ticketsmodule_msg_messages WHERE att_data IS NOT NULL AND att_key IS NULL`);
    const inStore = await pool.query(`SELECT COUNT(*)::int n FROM ticketsmodule_msg_messages WHERE att_key IS NOT NULL`);
    res.json({ ok: true, storageReady: storage.configured(), bucket: storage.BUCKET, inDb: inDb.rows[0].n, inDbBytes: Number(inDb.rows[0].bytes || 0), inStorage: inStore.rows[0].n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Миграция вложений из БД в объектное хранилище батчами (можно вызывать повторно).
router.post('/files/migrate', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    if (!isAppAdmin(req.user)) return res.status(403).json({ ok: false, error: 'Только админ' });
    if (!storage.configured()) return res.status(503).json({ ok: false, error: 'Хранилище не настроено (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
    const limit = Math.min(Math.max(+(req.body && req.body.limit) || 25, 1), 100);
    const rows = (await pool.query(`SELECT id, channel_id, att_name, att_type, att_data FROM ticketsmodule_msg_messages
      WHERE att_data IS NOT NULL AND att_key IS NULL ORDER BY id ASC LIMIT $1`, [limit])).rows;
    let moved = 0; const errors = [];
    for (const m of rows) {
      try {
        const ext = ((String(m.att_name || '').match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0] || '').toLowerCase();
        const k = `messenger/${m.channel_id}/${m.id}-${Math.random().toString(16).slice(2, 8)}${ext}`;
        await storage.upload(k, m.att_data, m.att_type || 'application/octet-stream');
        await pool.query('UPDATE ticketsmodule_msg_messages SET att_key=$1, att_data=NULL WHERE id=$2', [k, m.id]);
        moved++;
      } catch (e) { errors.push({ id: m.id, error: e.message }); }
    }
    const left = (await pool.query(`SELECT COUNT(*)::int n FROM ticketsmodule_msg_messages WHERE att_data IS NOT NULL AND att_key IS NULL`)).rows[0].n;
    res.json({ ok: true, moved, remaining: left, errors });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Модель агента: что настроено/активно + какие модели доступны аккаунту ──────
router.get('/agent/info', requireAuth(WRITE), async (req, res) => {
  try {
    const agent = require('../plsai-agent');
    const info = (agent.agentModelInfo && agent.agentModelInfo()) || {};
    let available = null;
    if (isAppAdmin(req.user) && agent.listAvailableModels) {
      const r = await agent.listAvailableModels();
      available = r.ok ? r.models : { error: r.error };
    }
    res.json({ ok: true, configured: info.configured, fallback: info.fallback, active: info.active, available });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Пересинхронизировать справочники (отделы из Битрикса + сотрудники) — только админ.
router.post('/agent/sync-refs', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    if (!isAppAdmin(req.user)) return res.status(403).json({ ok: false, error: 'Только админ' });
    const out = await require('../departments-sync').syncRefs();
    res.json(Object.assign({ ok: true }, out));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
    const locked = !!(req.body && req.body.locked);
    const members = Array.from(new Set([uid(req), ...((req.body && req.body.memberIds) || []).map(Number).filter(Boolean)]));
    const adminIds = new Set([uid(req), ...((req.body && req.body.adminIds) || []).map(Number).filter(Boolean)]);
    const c = await pool.query(`INSERT INTO ticketsmodule_msg_channels (kind, title, created_by, locked) VALUES ('group',$1,$2,$3) RETURNING id`, [title, uid(req), locked]);
    const cid = c.rows[0].id;
    const vals = members.map((_, i) => `($1,$${i + 2},${adminIds.has(members[i]) ? "'admin'" : "'member'"})`).join(',');
    await pool.query(`INSERT INTO ticketsmodule_msg_members (channel_id, user_id, role) VALUES ${vals} ON CONFLICT DO NOTHING`, [cid, ...members]);
    await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'system',$2)`, [cid, 'Канал создан: ' + title]);
    res.json({ ok: true, channelId: cid });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Управление группой (участники, роли, блокировка) — только админ канала ────
router.get('/channels/:id(\\d+)/info', requireAuth(WRITE), async (req, res) => {
  try {
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).json({ ok: false, error: 'Нет доступа' });
    const c = await pool.query('SELECT id, kind, title, locked FROM ticketsmodule_msg_channels WHERE id=$1', [cid]);
    if (!c.rows[0]) return res.status(404).json({ ok: false, error: 'Нет канала' });
    const mem = await pool.query(`SELECT m.user_id, m.role, u.display_name AS name, u.job_title AS title
      FROM ticketsmodule_msg_members m LEFT JOIN ticketsmodule_users u ON u.id=m.user_id WHERE m.channel_id=$1 ORDER BY u.display_name`, [cid]);
    res.json({ ok: true, channel: { id: c.rows[0].id, kind: c.rows[0].kind, title: c.rows[0].title, locked: !!c.rows[0].locked },
      members: mem.rows, iAmAdmin: await isChannelAdmin(cid, req.user) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/channels/:id(\\d+)/members', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const cid = +req.params.id;
    const c = await pool.query('SELECT kind FROM ticketsmodule_msg_channels WHERE id=$1', [cid]);
    if (!c.rows[0] || c.rows[0].kind !== 'group') return res.status(400).json({ ok: false, error: 'Только для групп' });
    if (!(await isChannelAdmin(cid, req.user))) return res.status(403).json({ ok: false, error: 'Только админ канала' });
    const ids = Array.from(new Set(((req.body && req.body.userIds) || []).map(Number).filter(Boolean)));
    if (!ids.length) return res.status(400).json({ ok: false, error: 'Некого добавлять' });
    const vals = ids.map((_, i) => `($1,$${i + 2},'member')`).join(',');
    await pool.query(`INSERT INTO ticketsmodule_msg_members (channel_id, user_id, role) VALUES ${vals} ON CONFLICT DO NOTHING`, [cid, ...ids]);
    const names = await pool.query('SELECT display_name FROM ticketsmodule_users WHERE id = ANY($1)', [ids]);
    await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'system',$2)`,
      [cid, req.user.display_name + ' добавил(а): ' + names.rows.map(x => x.display_name).join(', ')]);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/channels/:id(\\d+)/remove', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const cid = +req.params.id, target = +(req.body && req.body.userId);
    if (!(await isChannelAdmin(cid, req.user))) return res.status(403).json({ ok: false, error: 'Только админ канала' });
    if (!target) return res.status(400).json({ ok: false, error: 'userId' });
    await pool.query('DELETE FROM ticketsmodule_msg_members WHERE channel_id=$1 AND user_id=$2', [cid, target]);
    const n = await pool.query('SELECT display_name FROM ticketsmodule_users WHERE id=$1', [target]);
    await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'system',$2)`,
      [cid, req.user.display_name + ' удалил(а): ' + ((n.rows[0] && n.rows[0].display_name) || ('#' + target))]);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/channels/:id(\\d+)/role', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const cid = +req.params.id, target = +(req.body && req.body.userId), role = (req.body && req.body.role) === 'admin' ? 'admin' : 'member';
    if (!(await isChannelAdmin(cid, req.user))) return res.status(403).json({ ok: false, error: 'Только админ канала' });
    if (!target) return res.status(400).json({ ok: false, error: 'userId' });
    await pool.query('UPDATE ticketsmodule_msg_members SET role=$1 WHERE channel_id=$2 AND user_id=$3', [role, cid, target]);
    const n = await pool.query('SELECT display_name FROM ticketsmodule_users WHERE id=$1', [target]);
    await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'system',$2)`,
      [cid, ((n.rows[0] && n.rows[0].display_name) || ('#' + target)) + (role === 'admin' ? ' — назначен(а) админом канала' : ' — снят(а) с админа')]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/channels/:id(\\d+)/lock', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const cid = +req.params.id, locked = !!(req.body && req.body.locked);
    if (!(await isChannelAdmin(cid, req.user))) return res.status(403).json({ ok: false, error: 'Только админ канала' });
    await pool.query('UPDATE ticketsmodule_msg_channels SET locked=$1 WHERE id=$2', [locked, cid]);
    await pool.query(`INSERT INTO ticketsmodule_msg_messages (channel_id, author_id, kind, body) VALUES ($1,NULL,'system',$2)`,
      [cid, locked ? 'Канал закрыт: писать могут только админы' : 'Канал открыт: писать могут все участники']);
    await pool.query('UPDATE ticketsmodule_msg_channels SET last_at=NOW() WHERE id=$1', [cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Отделы (teams): список и управление — управление только для админа ────────
router.get('/teams', requireAuth(WRITE), async (req, res) => {
  try { res.json({ ok: true, teams: await listTeams() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/teams', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    if (!isAppAdmin(req.user)) return res.status(403).json({ ok: false, error: 'Только админ' });
    const name = String((req.body && req.body.name) || '').trim().slice(0, 120);
    if (!name) return res.status(400).json({ ok: false, error: 'Укажите название отдела' });
    const ids = Array.from(new Set(((req.body && req.body.memberIds) || []).map(Number).filter(Boolean)));
    let teamId = +(req.body && req.body.id) || 0;
    if (teamId) {
      await pool.query('UPDATE ticketsmodule_msg_teams SET name=$1 WHERE id=$2', [name, teamId]);
      await pool.query('DELETE FROM ticketsmodule_msg_team_members WHERE team_id=$1', [teamId]);
    } else {
      const t = await pool.query('INSERT INTO ticketsmodule_msg_teams (name, created_by) VALUES ($1,$2) RETURNING id', [name, uid(req)]);
      teamId = t.rows[0].id;
    }
    if (ids.length) {
      const vals = ids.map((_, i) => `($1,$${i + 2})`).join(',');
      await pool.query(`INSERT INTO ticketsmodule_msg_team_members (team_id, user_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [teamId, ...ids]);
    }
    res.json({ ok: true, id: teamId });
  } catch (e) {
    if (String(e.message).includes('uq_msg_team_name')) return res.status(400).json({ ok: false, error: 'Отдел с таким названием уже есть' });
    res.status(500).json({ ok: false, error: e.message });
  }
});
router.post('/teams/:id(\\d+)/delete', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    if (!isAppAdmin(req.user)) return res.status(403).json({ ok: false, error: 'Только админ' });
    const tid = +req.params.id;
    await pool.query('DELETE FROM ticketsmodule_msg_team_members WHERE team_id=$1', [tid]);
    await pool.query('DELETE FROM ticketsmodule_msg_teams WHERE id=$1', [tid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Прочитано / реакция ──────────────────────────────────────────────────────
router.post('/read', requireAuth(WRITE), express.json(), async (req, res) => {
  try {
    const cid = +(req.body && req.body.channelId), lastId = +(req.body && req.body.lastId) || 0;
    if (!cid) return res.status(400).json({ ok: false, error: 'channelId' });
    // Критично и независимо: last_read_id (эта колонка есть всегда — она в CREATE
    // TABLE). Отдельный запрос, чтобы пометка прочтения сохранялась, даже если
    // доп-колонок (last_read_at) в БД нет. last_read_at — лучшее-из-возможного.
    await pool.query(`UPDATE ticketsmodule_msg_members SET last_read_id = GREATEST(last_read_id,$1)
      WHERE channel_id=$2 AND user_id=$3`, [lastId, cid, uid(req)]);
    try { await pool.query(`UPDATE ticketsmodule_msg_members SET last_read_at = NOW()
      WHERE channel_id=$1 AND user_id=$2`, [cid, uid(req)]); }
    catch (e) { ensureMsgColumns().catch(() => {}); }
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

// ── Выгрузка истории канала (txt / html) ─────────────────────────────────────
router.get('/channels/:id(\\d+)/export', requireAuth(WRITE), async (req, res) => {
  try {
    await ensureMsgSchema();
    const cid = +req.params.id;
    if (!(await isMember(cid, uid(req)))) return res.status(403).send('Нет доступа');
    const fmt = (req.query.format === 'html') ? 'html' : 'txt';
    const ch = await pool.query('SELECT kind, title, dm_key FROM ticketsmodule_msg_channels WHERE id=$1', [cid]);
    const c = ch.rows[0] || {};
    let title = c.title || 'Диалог';
    if (c.kind === 'dm') {
      const mem = await pool.query(`SELECT u.display_name FROM ticketsmodule_msg_members m JOIN ticketsmodule_users u ON u.id=m.user_id WHERE m.channel_id=$1`, [cid]);
      title = mem.rows.map(x => x.display_name).join(' ↔ ') || 'Диалог';
    }
    const r = await pool.query(`
      SELECT m.id, m.author_id, m.kind, m.body, m.att_name, m.att_size, m.created_at, u.display_name AS author_name
      FROM ticketsmodule_msg_messages m LEFT JOIN ticketsmodule_users u ON u.id=m.author_id
      WHERE m.channel_id=$1 AND m.deleted_at IS NULL ORDER BY m.id ASC`, [cid]);
    const pad = n => String(n).padStart(2, '0');
    const fmtDt = d => { const x = new Date(d); return `${pad(x.getDate())}.${pad(x.getMonth() + 1)}.${x.getFullYear()} ${pad(x.getHours())}:${pad(x.getMinutes())}`; };
    const who = m => m.kind === 'ai' ? 'Агент ЦУП' : (m.author_name || 'Система');
    const line = m => { let t = m.kind === 'file' ? `[файл: ${m.att_name || 'файл'}]${m.body ? ' ' + m.body : ''}` : (m.body || ''); return { dt: fmtDt(m.created_at), who: who(m), text: t }; };
    const slug = title.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'chat';
    const today = new Date().toISOString().slice(0, 10);
    if (fmt === 'html') {
      const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const rows = r.rows.map(m => { const l = line(m); return `<div class="m"><span class="dt">${esc(l.dt)}</span> <b>${esc(l.who)}</b><div class="tx">${esc(l.text).replace(/\n/g, '<br>')}</div></div>`; }).join('\n');
      const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(title)} — выгрузка</title>
<style>body{font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#161c26}
h1{font-size:18px}.m{padding:8px 0;border-bottom:1px solid #eee}.dt{color:#8a94a6;font-size:12px}.tx{margin-top:3px;white-space:pre-wrap}</style></head>
<body><h1>${esc(title)}</h1><p style="color:#8a94a6;font-size:12px">Выгружено ${esc(today)} · сообщений: ${r.rows.length}</p>${rows}</body></html>`;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(slug + '_' + today + '.html')}`);
      return res.send(html);
    }
    const head = `Чат: ${title}\nВыгружено: ${today}\nСообщений: ${r.rows.length}\n${'='.repeat(40)}\n\n`;
    const text = head + r.rows.map(m => { const l = line(m); return `[${l.dt}] ${l.who}:\n${l.text}\n`; }).join('\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(slug + '_' + today + '.txt')}`);
    res.send('﻿' + text);
  } catch (e) { res.status(500).send(e.message); }
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

// Календарь ЦУП — единый агрегатор событий + свои события + цвета + переговорные.
//
// Три «календаря» (scope): company (всё по фирме), personal (только моё),
// rooms (переговорные из Bitrix). Агрегатор собирает события из уже
// существующих таблиц (задачи, отпуска/командировки, дни рождения,
// напоминания агента) и из собственной таблицы ticketsmodule_calendar_events
// (встречи/важные дела/события агента). Чужие источники — только чтение.
//
// Время храним в TIMESTAMPTZ, а клиент присылает/получает НАИВНОЕ локальное
// время Asia/Almaty (как в planner-routes.js), поэтому на обеих границах
// Postgres явно указываем зону.
const express = require('express');
const router = express.Router();
const { requireAuth, pool, auditLog } = require('../auth');

const TZ = 'Asia/Almaty';

// Категории и цвета по умолчанию (админ может переопределить, см. /colors).
const DEFAULT_COLORS = {
  meet:  '#2f6bed', // встречи
  task:  '#7a4ecc', // задачи и важные дела
  trip:  '#0ea5a4', // командировки
  vac:   '#16a37a', // отпуска
  sick:  '#e8821f', // больничные
  bd:    '#e0569b', // дни рождения
  agent: '#d9821a', // от агента ЦУП
  imp:   '#e5484d', // важное
};
// Переговорные по умолчанию (если Bitrix недоступен или ещё не сопоставлен).
const DEFAULT_ROOMS = [
  { id: 'expo',     name: 'Переговорная EXPO',     color: '#2f6bed' },
  { id: 'training', name: 'Переговорная Training', color: '#16a37a' },
];

let _ready = false;
async function ensure() {
  if (_ready) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_calendar_events (
      id SERIAL PRIMARY KEY,
      owner_id INTEGER,
      title VARCHAR(500) NOT NULL,
      category VARCHAR(20) NOT NULL DEFAULT 'meet',
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ,
      all_day BOOLEAN DEFAULT false,
      location TEXT DEFAULT '',
      note TEXT DEFAULT '',
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tm_cal_ev_owner ON ticketsmodule_calendar_events(owner_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tm_cal_ev_start ON ticketsmodule_calendar_events(start_at)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_calendar_settings (
      key VARCHAR(40) PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    _ready = true;
  } catch (e) { console.error('calendar schema:', e.message); }
}
ensure();

const isAdmin = (req) => ['admin', 'superadmin'].includes(req.user && req.user.role);
const DT = `'YYYY-MM-DD"T"HH24:MI'`;                                   // формат наивного локального времени
const esc = s => String(s == null ? '' : s);
function okDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function okDateTime(s) { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(s || '')); }

// ── Настройки (цвета) ──────────────────────────────────────────────────────
async function getColors() {
  try {
    const r = await pool.query(`SELECT value FROM ticketsmodule_calendar_settings WHERE key='colors'`);
    return Object.assign({}, DEFAULT_COLORS, (r.rows[0] && r.rows[0].value) || {});
  } catch (e) { return Object.assign({}, DEFAULT_COLORS); }
}
async function getRooms() {
  try {
    const r = await pool.query(`SELECT value FROM ticketsmodule_calendar_settings WHERE key='rooms'`);
    if (r.rows[0] && Array.isArray(r.rows[0].value) && r.rows[0].value.length) return r.rows[0].value;
  } catch (e) {}
  return DEFAULT_ROOMS.slice();
}

router.get('/colors', requireAuth(), async (req, res) => {
  await ensure();
  res.json({ ok: true, colors: await getColors(), canEdit: isAdmin(req) });
});
router.put('/colors', requireAuth(), express.json(), async (req, res) => {
  await ensure();
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Только администратор' });
  try {
    const body = req.body || {};
    const clean = {};
    for (const k of Object.keys(DEFAULT_COLORS)) {
      if (typeof body[k] === 'string' && /^#[0-9a-fA-F]{6}$/.test(body[k])) clean[k] = body[k];
    }
    await pool.query(
      `INSERT INTO ticketsmodule_calendar_settings (key, value, updated_at) VALUES ('colors',$1,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`, [JSON.stringify(clean)]);
    try { await auditLog(req.user.id, req.user.username, 'CALENDAR_COLORS_SET', null, clean, null, null); } catch (e) {}
    res.json({ ok: true, colors: Object.assign({}, DEFAULT_COLORS, clean) });
  } catch (e) { console.error('calendar colors put:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// ── Агрегатор событий ──────────────────────────────────────────────────────
// GET /events?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=company|personal
router.get('/events', requireAuth(), async (req, res) => {
  await ensure();
  const from = okDate(req.query.from) ? req.query.from : null;
  const to = okDate(req.query.to) ? req.query.to : null;
  if (!from || !to) return res.status(400).json({ ok: false, error: 'from/to обязательны (YYYY-MM-DD)' });
  const personal = req.query.scope === 'personal';
  const me = req.user;
  const events = [];
  const add = (e) => events.push(e);

  // 1) Собственные события календаря
  try {
    const params = [from, to];
    let where = `start_at < ($2::date + 1) AND COALESCE(end_at, start_at) >= $1::date`;
    if (personal) { where += ` AND owner_id = $3`; params.push(me.id); }
    const r = await pool.query(
      `SELECT id, owner_id, title, category, all_day, location, note, source,
              to_char(start_at AT TIME ZONE '${TZ}', ${DT}) AS s,
              to_char(COALESCE(end_at, start_at) AT TIME ZONE '${TZ}', ${DT}) AS e
         FROM ticketsmodule_calendar_events WHERE ${where}`, params);
    for (const x of r.rows) {
      add({ id: 'cal:' + x.id, source: 'calendar', category: x.category || 'meet',
        title: x.title, start: x.all_day ? x.s.slice(0, 10) : x.s,
        end: x.all_day ? x.e.slice(0, 10) : x.e, allDay: x.all_day,
        location: x.location || '', note: x.note || '',
        editable: (x.owner_id === me.id) || isAdmin(req) });
    }
  } catch (e) { console.error('cal events own:', e.message); }

  // 2) Задачи с дедлайном (ticketsmodule_board_cards) — свои (таблица per-user)
  try {
    const r = await pool.query(
      `SELECT id, title, due_date FROM ticketsmodule_board_cards
        WHERE user_id = $1 AND archived = FALSE AND column_key <> 'done'
          AND due_date IS NOT NULL AND due_date BETWEEN $2 AND $3`, [me.id, from, to]);
    for (const x of r.rows) {
      const d = new Date(x.due_date).toISOString().slice(0, 10);
      add({ id: 'task:' + x.id, source: 'board', category: 'task', title: x.title,
        start: d, end: d, allDay: true, url: '/board.html', editable: false });
    }
  } catch (e) { console.error('cal board:', e.message); }

  // 3) Отпуска / командировки / больничные (ticketsmodule_portal_absences)
  try {
    const params = [from, to];
    let where = `from_date <> '' AND to_date <> '' AND from_date <= $2 AND to_date >= $1`;
    if (personal) { where += ` AND name = $3`; params.push(me.display_name || me.username || ''); }
    const r = await pool.query(
      `SELECT id, name, kind, from_date, to_date, note FROM ticketsmodule_portal_absences WHERE ${where}`, params);
    for (const x of r.rows) {
      const cat = x.kind === 'trip' ? 'trip' : (x.kind === 'sick' ? 'sick' : 'vac');
      const label = x.kind === 'trip' ? 'Командировка' : (x.kind === 'sick' ? 'Больничный' : 'Отпуск');
      add({ id: 'abs:' + x.id, source: 'absence', category: cat,
        title: label + ' — ' + x.name, start: x.from_date, end: x.to_date, allDay: true,
        note: x.note || '', who: x.name, editable: false });
    }
  } catch (e) { console.error('cal absences:', e.message); }

  // 4) Выезды/командировки из планировщика (ticketsmodule_planner_events)
  try {
    const params = [from, to];
    let where = `start_at < ($2::date + 1) AND end_at >= $1::date`;
    if (personal && me.engineer_name) { where += ` AND resource = $3`; params.push(me.engineer_name); }
    else if (personal) { where += ` AND FALSE`; }
    const r = await pool.query(
      `SELECT id, resource, title, type, all_day,
              to_char(start_at AT TIME ZONE '${TZ}', ${DT}) AS s,
              to_char(end_at AT TIME ZONE '${TZ}', ${DT}) AS e
         FROM ticketsmodule_planner_events WHERE ${where} LIMIT 500`, params);
    for (const x of r.rows) {
      add({ id: 'pln:' + x.id, source: 'planner', category: 'trip',
        title: (x.title || 'Выезд') + (x.resource ? ' — ' + x.resource : ''),
        start: x.all_day ? x.s.slice(0, 10) : x.s, end: x.all_day ? x.e.slice(0, 10) : x.e,
        allDay: x.all_day, who: x.resource || '', url: '/planner.html', editable: false });
    }
  } catch (e) { console.error('cal planner:', e.message); }

  // 5) Дни рождения (ticketsmodule_staff_birthdays) — повторяются ежегодно
  if (!personal) {
    try {
      const r = await pool.query(`SELECT full_name, birth_month, birth_day FROM ticketsmodule_staff_birthdays`);
      const years = new Set([+from.slice(0, 4), +to.slice(0, 4)]);
      for (const x of r.rows) {
        if (!x.birth_month || !x.birth_day) continue;
        for (const y of years) {
          const d = `${y}-${String(x.birth_month).padStart(2, '0')}-${String(x.birth_day).padStart(2, '0')}`;
          if (d >= from && d <= to) add({ id: 'bd:' + x.full_name + ':' + y, source: 'birthday',
            category: 'bd', title: 'День рождения — ' + x.full_name, start: d, end: d, allDay: true, editable: false });
        }
      }
    } catch (e) { console.error('cal birthdays:', e.message); }
  }

  // 6) Напоминания агента (ticketsmodule_agent_reminders) — мои
  try {
    const r = await pool.query(
      `SELECT id, title, note, due_date FROM ticketsmodule_agent_reminders
        WHERE user_id = $1 AND done = false AND due_date IS NOT NULL AND due_date BETWEEN $2 AND $3`,
      [me.id, from, to]);
    for (const x of r.rows) {
      const d = new Date(x.due_date).toISOString().slice(0, 10);
      add({ id: 'rem:' + x.id, source: 'agent', category: 'agent',
        title: x.title || 'Напоминание', note: x.note || '', start: d, end: d, allDay: true, editable: false });
    }
  } catch (e) { console.error('cal reminders:', e.message); }

  res.json({ ok: true, events, colors: await getColors() });
});

// ── CRUD собственных событий ───────────────────────────────────────────────
const CATS = Object.keys(DEFAULT_COLORS);
function startEndExpr(allDay, start, end) {
  // Возвращает {sql fragments, values} — не используется напрямую, см. ниже.
}
router.post('/events', requireAuth(), express.json(), async (req, res) => {
  await ensure();
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 500);
    if (!title) return res.status(400).json({ ok: false, error: 'Нужен заголовок' });
    const category = CATS.includes(b.category) ? b.category : 'meet';
    const allDay = !!b.allDay;
    let startVal, endVal;
    if (allDay) {
      if (!okDate(b.start)) return res.status(400).json({ ok: false, error: 'Неверная дата' });
      startVal = b.start + 'T00:00';
      endVal = okDate(b.end) ? b.end + 'T00:00' : startVal;
    } else {
      if (!okDateTime(b.start)) return res.status(400).json({ ok: false, error: 'Неверное время начала' });
      startVal = b.start.slice(0, 16);
      endVal = okDateTime(b.end) ? b.end.slice(0, 16) : startVal;
    }
    // Задача (category='task') — это не локальное событие календаря, а НАСТОЯЩАЯ
    // задача: создаём её в Bitrix24 (tasks.task.add) И в «Мои задачи» ЦУП (доска).
    // Локальное событие НЕ создаём — календарь и так показывает карточки доски,
    // иначе была бы дубль-строка. Отображается она по дате дедлайна (due_date).
    if (category === 'task') {
      const { b24 } = require('../bitrix');
      const bid = req.user.bitrix_user_id || null;
      const dueISO = String(b.start).slice(0, 10);               // YYYY-MM-DD
      const deadline = allDay ? dueISO : endVal;                 // Bitrix DEADLINE
      const descr = String(b.note || '').slice(0, 2000);
      let bitrixTaskId = null, refUrl = null;
      if (bid) {
        try {
          const tr = await b24('tasks.task.add', { fields: {
            TITLE: title, RESPONSIBLE_ID: bid, CREATED_BY: bid,
            DEADLINE: deadline, DESCRIPTION: descr,
          } });
          const t = tr && tr.result && tr.result.task;
          bitrixTaskId = t && (t.id || t.ID) || null;
          if (bitrixTaskId) refUrl = `https://crm.prolabsupport.kz/company/personal/user/${bid}/tasks/task/view/${bitrixTaskId}/`;
        } catch (e) { console.error('cal task→bitrix:', e.message); }
      }
      try {
        const pr = await pool.query(
          `SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_board_cards WHERE user_id=$1 AND column_key='todo' AND archived=FALSE`,
          [req.user.id]);
        await pool.query(
          `INSERT INTO ticketsmodule_board_cards (user_id, column_key, title, notes, due_date, position, ref_type, ref_id, ref_url)
           VALUES ($1,'todo',$2,$3,$4,$5,$6,$7,$8)`,
          [req.user.id, title, descr || null, dueISO, pr.rows[0].p,
           bitrixTaskId ? 'task' : null, bitrixTaskId ? String(bitrixTaskId) : null, refUrl]);
      } catch (e) { console.error('cal task→board:', e.message); }
      return res.json({ ok: true, task: true, bitrixTaskId });
    }
    const r = await pool.query(
      `INSERT INTO ticketsmodule_calendar_events (owner_id, title, category, start_at, end_at, all_day, location, note, source, created_by)
       VALUES ($1,$2,$3, ($4)::timestamp AT TIME ZONE '${TZ}', ($5)::timestamp AT TIME ZONE '${TZ}', $6,$7,$8,'manual',$9) RETURNING id`,
      [req.user.id, title, category, startVal, endVal, allDay, String(b.location || '').slice(0, 300), String(b.note || '').slice(0, 2000), req.user.username]);
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { console.error('cal create:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});
router.patch('/events/:id', requireAuth(), express.json(), async (req, res) => {
  await ensure();
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query(`SELECT owner_id FROM ticketsmodule_calendar_events WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.status(404).json({ ok: false, error: 'Не найдено' });
    if (cur.rows[0].owner_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ ok: false, error: 'Можно менять только свои события' });
    const b = req.body || {};
    const sets = []; const vals = []; let n = 1;
    if (typeof b.title === 'string') { sets.push(`title=$${n++}`); vals.push(b.title.slice(0, 500)); }
    if (CATS.includes(b.category)) { sets.push(`category=$${n++}`); vals.push(b.category); }
    if (typeof b.location === 'string') { sets.push(`location=$${n++}`); vals.push(b.location.slice(0, 300)); }
    if (typeof b.note === 'string') { sets.push(`note=$${n++}`); vals.push(b.note.slice(0, 2000)); }
    if ('allDay' in b || 'start' in b || 'end' in b) {
      const allDay = !!b.allDay;
      let startVal, endVal;
      if (allDay) { if (!okDate(b.start)) return res.status(400).json({ ok: false, error: 'Неверная дата' }); startVal = b.start + 'T00:00'; endVal = okDate(b.end) ? b.end + 'T00:00' : startVal; }
      else { if (!okDateTime(b.start)) return res.status(400).json({ ok: false, error: 'Неверное время' }); startVal = b.start.slice(0, 16); endVal = okDateTime(b.end) ? b.end.slice(0, 16) : startVal; }
      sets.push(`all_day=$${n++}`); vals.push(allDay);
      sets.push(`start_at=($${n++})::timestamp AT TIME ZONE '${TZ}'`); vals.push(startVal);
      sets.push(`end_at=($${n++})::timestamp AT TIME ZONE '${TZ}'`); vals.push(endVal);
    }
    if (!sets.length) return res.json({ ok: true });
    sets.push(`updated_at=NOW()`);
    vals.push(id);
    await pool.query(`UPDATE ticketsmodule_calendar_events SET ${sets.join(', ')} WHERE id=$${n}`, vals);
    res.json({ ok: true });
  } catch (e) { console.error('cal patch:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});
router.delete('/events/:id', requireAuth(), async (req, res) => {
  await ensure();
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query(`SELECT owner_id FROM ticketsmodule_calendar_events WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.json({ ok: true });
    if (cur.rows[0].owner_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ ok: false, error: 'Можно удалять только свои события' });
    await pool.query(`DELETE FROM ticketsmodule_calendar_events WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { console.error('cal delete:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// ── Переговорные (нативно в ЦУП/Supabase, без Bitrix) ──────────────────────
// Переговорные и брони хранятся в ЦУП. Старые брони Bitrix «Conference room»
// переносятся разовым импортом (POST /rooms/import-bitrix).
let _roomsReady = false;
async function ensureRooms() {
  if (_roomsReady) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_calendar_rooms (
      id SERIAL PRIMARY KEY, name VARCHAR(200) NOT NULL, building VARCHAR(200) DEFAULT '',
      color VARCHAR(16) DEFAULT '#2f6bed', active BOOLEAN DEFAULT true, position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_room_bookings (
      id SERIAL PRIMARY KEY, room_id INTEGER NOT NULL, title VARCHAR(300) DEFAULT '',
      user_id INTEGER, booker_name VARCHAR(200) DEFAULT '',
      start_at TIMESTAMPTZ NOT NULL, end_at TIMESTAMPTZ NOT NULL,
      source VARCHAR(20) DEFAULT 'cup', bitrix_event_id VARCHAR(40), created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tm_rbk_room_time ON ticketsmodule_room_bookings(room_id, start_at, end_at)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tm_rbk_bx ON ticketsmodule_room_bookings(bitrix_event_id) WHERE bitrix_event_id IS NOT NULL`);
    const c = await pool.query(`SELECT COUNT(*)::int AS n FROM ticketsmodule_calendar_rooms`);
    if (!c.rows[0].n) {
      await pool.query(`INSERT INTO ticketsmodule_calendar_rooms (name, building, color, position) VALUES
        ('Переговорная EXPO','Здание EXPO','#2f6bed',1),
        ('Переговорная Training','Здание Training','#16a37a',2)`);
    }
    // Разовая чистка: «Переговорная Тренинг-центр» лишняя (Training и есть ТЦ) — скрываем.
    await pool.query(`UPDATE ticketsmodule_calendar_rooms SET active=false WHERE name='Переговорная Тренинг-центр' AND active=true`);
    _roomsReady = true;
  } catch (e) { console.error('rooms schema:', e.message); }
}
ensureRooms();

async function listRooms() {
  await ensureRooms();
  const r = await pool.query(`SELECT id, name, building, color FROM ticketsmodule_calendar_rooms WHERE active=true ORDER BY position, id`);
  return r.rows.map(x => ({ id: 'r' + x.id, sid: String(x.id), rid: x.id, name: x.name, building: x.building || '', color: x.color || '#2f6bed' }));
}
async function roomBookings(from, to) {
  await ensureRooms();
  const r = await pool.query(
    `SELECT id, room_id, title, booker_name, start_at, end_at FROM ticketsmodule_room_bookings
      WHERE start_at < ($2::date + 1) AND end_at >= $1::date ORDER BY start_at`, [from, to]);
  return r.rows.map(x => ({ id: x.id, room: 'r' + x.room_id, title: x.title || 'Бронь', who: x.booker_name || '',
    startRaw: x.start_at, endRaw: x.end_at }));
}
// Создать бронь (с проверкой пересечения). Бросает «…занята» при конфликте.
async function bookRoom(roomId, title, startLocal, endLocal, user) {
  await ensureRooms();
  const rid = parseInt(roomId, 10);
  if (!rid) throw new Error('Не указана переговорная');
  const sL = String(startLocal).slice(0, 16), eL = String(endLocal).slice(0, 16);
  const clash = await pool.query(
    `SELECT 1 FROM ticketsmodule_room_bookings WHERE room_id=$1
       AND start_at < ($3)::timestamp AT TIME ZONE '${TZ}' AND end_at > ($2)::timestamp AT TIME ZONE '${TZ}' LIMIT 1`,
    [rid, sL, eL]);
  if (clash.rows.length) throw new Error('На это время переговорная уже занята');
  const r = await pool.query(
    `INSERT INTO ticketsmodule_room_bookings (room_id, title, user_id, booker_name, start_at, end_at, source)
     VALUES ($1,$2,$3,$4, ($5)::timestamp AT TIME ZONE '${TZ}', ($6)::timestamp AT TIME ZONE '${TZ}','cup') RETURNING id`,
    [rid, String(title || '').slice(0, 300), user && user.id, (user && (user.display_name || user.username)) || '', sL, eL]);
  return r.rows[0].id;
}

// ── Синк переговорной «Экспо» с Б24 (location-календарь «Conference room») ────
// Б24 — источник правды: бронь создаёт только Битрикс, ЦУП отражает. Комнату
// «Экспо» ЦУП держим в синхроне со section=5 (единственная location-переговорная
// Б24). Комната «Training» — только в ЦУП, не синкается.
const EXPO_SECTION = '5';           // calendar section «Conference room» = Экспо
let _expoSyncAt = 0, _expoSyncing = false;
async function expoRoomId() {
  await ensureRooms();
  const r = await pool.query(
    `SELECT id FROM ticketsmodule_calendar_rooms
      WHERE active=true AND (name ILIKE '%EXPO%' OR name ILIKE '%Экспо%') ORDER BY position, id LIMIT 1`);
  return r.rows[0] && r.rows[0].id;
}
// Подтянуть все брони «Conference room» из Б24 в комнату «Экспо» (upsert по
// bitrix_event_id) и снять те, что отменены в Б24 (нет в окне −3мес…+12мес).
async function syncBitrixExpo() {
  await ensureRooms();
  const rid = await expoRoomId();
  if (!rid) return { ok: false, error: 'нет комнаты Экспо' };
  const { b24 } = require('../bitrix');
  const pd = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 19);
  const from = pd(-92), to = pd(366);        // −3 мес … +12 мес
  const r = await b24('calendar.event.get', { type: 'location', ownerId: 0, from, to });
  const evs = Array.isArray(r && r.result) ? r.result : [];
  const seen = [];
  let added = 0, updated = 0;
  for (const ev of evs) {
    if (String(ev.SECTION_ID || ev.SECT_ID || '') !== EXPO_SECTION) continue;
    if (String(ev.DELETED || '') === 'Y') continue;
    const bxId = String(ev.ID || ''); const tsF = +ev.DATE_FROM_TS_UTC, tsT = +ev.DATE_TO_TS_UTC;
    if (!bxId || !tsF || !tsT) continue;
    seen.push(bxId);
    const name = String(ev.NAME || 'Бронь').slice(0, 300);
    const by = ev.CREATED_BY ? parseInt(ev.CREATED_BY, 10) : null;
    const up = await pool.query(
      `INSERT INTO ticketsmodule_room_bookings (room_id,title,user_id,booker_name,start_at,end_at,source,bitrix_event_id)
       VALUES ($1,$2,$3,$4,to_timestamp($5),to_timestamp($6),'bitrix',$7)
       ON CONFLICT (bitrix_event_id) WHERE bitrix_event_id IS NOT NULL DO UPDATE SET
         room_id=$1, user_id=$3, booker_name=$4, start_at=to_timestamp($5), end_at=to_timestamp($6)
       RETURNING (xmax=0) AS inserted`,
      [rid, name, by, name, tsF, tsT, bxId]);
    if (up.rows[0] && up.rows[0].inserted) added++; else updated++;
  }
  const del = await pool.query(
    `DELETE FROM ticketsmodule_room_bookings
       WHERE room_id=$1 AND source='bitrix' AND bitrix_event_id IS NOT NULL
         AND start_at >= NOW() - interval '100 days' AND start_at <= NOW() + interval '370 days'
         AND NOT (bitrix_event_id = ANY($2::text[]))`,
    [rid, seen.length ? seen : ['__none__']]);
  _expoSyncAt = Date.now();
  return { ok: true, total: evs.length, added, updated, removed: del.rowCount };
}
// Троттлед-обёртка: не чаще раза в 90 c, ошибки глотаем (синк не должен ронять UI).
async function syncBitrixExpoThrottled(force) {
  if (_expoSyncing) return;
  if (!force && Date.now() - _expoSyncAt < 90 * 1000) return;
  _expoSyncing = true;
  try { await syncBitrixExpo(); } catch (e) { console.error('syncBitrixExpo:', e.message); }
  finally { _expoSyncing = false; }
}

// ── Фаза 2: создание брони «Экспо» в Б24 (бронь создаёт Битрикс) + участники ──
const escTxt = s => String(s == null ? '' : s).replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));

// Уведомить участника о собрании: Telegram + email (best-effort, не валит бронь).
async function notifyParticipant(bid, info) {
  bid = parseInt(bid, 10); if (!bid) return;
  let USERS = {}, USER_EMAILS = {}, tgTo = null, sendEmailTo = null;
  try { ({ USERS, USER_EMAILS } = require('../constants')); } catch (e) {}
  try { ({ tgTo, sendEmailTo } = require('../notifications')); } catch (e) {}
  const dt = String(info.startLocal).replace('T', ' ').slice(0, 16);
  const et = String(info.endLocal).slice(11, 16);
  const subj = `Собрание: ${info.title || 'без темы'} — ${dt}`;
  const lines = [
    'Вас добавили участником собрания в Битрикс24.',
    'Тема: ' + (info.title || '—'),
    'Когда: ' + dt + ' – ' + et,
    'Переговорная: ' + (info.room || 'Экспо'),
    info.organizerName ? ('Организатор: ' + info.organizerName) : '',
  ].filter(Boolean);
  try {
    const r = await pool.query('SELECT telegram_chat_id FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [bid]);
    const chat = r.rows[0] && r.rows[0].telegram_chat_id;
    if (chat && tgTo) await tgTo(String(chat), '📅 <b>' + escTxt(subj) + '</b>\n' + lines.map(escTxt).join('\n'));
  } catch (e) { /* best-effort */ }
  try {
    const email = USER_EMAILS[bid];
    if (email && sendEmailTo) await sendEmailTo(email, subj, '<p>' + lines.map(escTxt).join('<br>') + '</p>');
  } catch (e) { /* best-effort */ }
}

// Создать бронь «Экспо» в Б24: встреча организатора + резерв переговорной (section 5)
// + участники (attendees → им приходит приглашение Б24). Возвращает id встречи.
async function bookExpoBitrix({ title, startLocal, endLocal, organizerBid, participantBids, note }) {
  const { b24 } = require('../bitrix');
  organizerBid = parseInt(organizerBid, 10);
  if (!organizerBid) throw new Error('не удалось определить организатора (нет привязки к Битрикс)');
  const attendees = [...new Set([organizerBid, ...(participantBids || []).map(n => parseInt(n, 10)).filter(Boolean)])];
  const from = String(startLocal).replace('T', ' ').slice(0, 16) + ':00';
  const to = String(endLocal).replace('T', ' ').slice(0, 16) + ':00';
  const r = await b24('calendar.event.add', {
    type: 'user', ownerId: organizerBid, from, to, timezone: TZ,
    name: String(title || 'Собрание').slice(0, 255), description: String(note || ''),
    location: 'calendar_' + EXPO_SECTION + '_0', attendees, is_meeting: 'Y', host: organizerBid,
  });
  const meetingId = r && r.result;
  if (!meetingId) throw new Error('Битрикс не создал событие');
  // id резерва переговорной (location event) — чтобы сразу отразить бронь в ЦУП.
  let locId = null;
  try {
    const g = await b24('calendar.event.getbyid', { id: meetingId });
    const m = /_(\d+)$/.exec(String((g && g.result && g.result.LOCATION) || ''));
    if (m) locId = m[1];
  } catch (e) { /* не критично */ }
  return { meetingId, locId, attendees };
}

// Единая точка брони переговорной (для HTTP и для ProLab AI).
// Экспо → создаётся в Б24 (+участники+уведомления); Training/прочие → локально в ЦУП.
async function createRoomBooking({ roomId, title, start, end, user, participants, note }) {
  await ensureRooms();
  const rid = parseInt(roomId, 10);
  if (!rid) throw new Error('Не указана переговорная');
  const expoId = await expoRoomId();
  if (expoId && rid === expoId) {
    const orgBid = user && user.bitrix_user_id ? parseInt(user.bitrix_user_id, 10) : null;
    if (!orgBid) { const e = new Error('Для брони «Экспо» нужен ваш аккаунт Битрикс (нет привязки)'); e.code = 400; throw e; }
    const sL = String(start).slice(0, 16), eL = String(end).slice(0, 16);
    const clash = await pool.query(
      `SELECT 1 FROM ticketsmodule_room_bookings WHERE room_id=$1
         AND start_at < ($3)::timestamp AT TIME ZONE '${TZ}' AND end_at > ($2)::timestamp AT TIME ZONE '${TZ}' LIMIT 1`,
      [expoId, sL, eL]);
    if (clash.rows.length) { const e = new Error('На это время переговорная уже занята'); e.code = 409; throw e; }
    const pbids = (Array.isArray(participants) ? participants : []).map(n => parseInt(n, 10)).filter(Boolean);
    const { meetingId, locId } = await bookExpoBitrix({ title, startLocal: sL, endLocal: eL, organizerBid: orgBid, participantBids: pbids, note });
    const orgName = (user.display_name || user.username || '');
    // Отразить бронь в ЦУП сразу (тему держим в title; синк её не затирает).
    try {
      if (locId) await pool.query(
        `INSERT INTO ticketsmodule_room_bookings (room_id,title,user_id,booker_name,start_at,end_at,source,bitrix_event_id)
         VALUES ($1,$2,$3,$4,($5)::timestamp AT TIME ZONE '${TZ}',($6)::timestamp AT TIME ZONE '${TZ}','bitrix',$7)
         ON CONFLICT (bitrix_event_id) WHERE bitrix_event_id IS NOT NULL
         DO UPDATE SET title=EXCLUDED.title, room_id=$1, user_id=$3, booker_name=$4, start_at=EXCLUDED.start_at, end_at=EXCLUDED.end_at`,
        [expoId, String(title || 'Собрание').slice(0, 300), orgBid, orgName, sL, eL, String(locId)]);
    } catch (e) { console.error('expo local insert:', e.message); }
    syncBitrixExpoThrottled(true).catch(() => {}); // фоновый дозин с Б24, ответ не блокируем
    let notified = 0;
    for (const pid of [...new Set(pbids.filter(x => x !== orgBid))]) {
      notifyParticipant(pid, { title, room: 'Переговорная EXPO', startLocal: sL, endLocal: eL, organizerName: orgName }).catch(() => {});
      notified++;
    }
    return { ok: true, bitrix: true, meetingId, notified, roomName: 'Переговорная EXPO' };
  }
  // Training и прочие — только ЦУП
  const id = await bookRoom(rid, title, start, end, user);
  const rooms = await listRooms();
  const rm = rooms.find(r => r.rid === rid);
  return { ok: true, bitrix: false, id, roomName: rm ? rm.name : '' };
}

router.get('/rooms', requireAuth(), async (req, res) => {
  await ensure();
  const from = okDate(req.query.from) ? req.query.from : new Date().toISOString().slice(0, 10);
  const to = okDate(req.query.to) ? req.query.to : from;
  try {
    syncBitrixExpoThrottled().catch(() => {});   // синк с Б24 в ФОНЕ — ответ не блокируем
    const rooms = await listRooms();
    const bookings = await roomBookings(from, to);
    res.json({ ok: true, rooms, bookings, source: 'cup', canManage: isAdmin(req) });
  } catch (e) { console.error('cal rooms:', e.message); res.json({ ok: true, rooms: [], bookings: [], warn: e.message }); }
});
router.post('/rooms/book', requireAuth(), express.json(), async (req, res) => {
  await ensure();
  try {
    const b = req.body || {};
    if (!okDateTime(b.start) || !okDateTime(b.end)) return res.status(400).json({ ok: false, error: 'Нужны начало и конец (со временем)' });
    if (b.end.slice(0, 16) <= b.start.slice(0, 16)) return res.status(400).json({ ok: false, error: 'Конец должен быть позже начала' });
    const out = await createRoomBooking({ roomId: b.sectionId || b.roomId, title: b.title, start: b.start, end: b.end, user: req.user, participants: b.participants, note: b.note });
    try { await auditLog(req.user.id, req.user.username, out.bitrix ? 'ROOM_BOOK_BX' : 'ROOM_BOOK', null, { roomId: b.sectionId || b.roomId, title: b.title, from: b.start, to: b.end, participants: b.participants || [], meetingId: out.meetingId }, req.ip, req.headers['user-agent']); } catch (e) {}
    res.json(out);
  } catch (e) { const code = e.code || (/занята/.test(e.message) ? 409 : 500); res.status(code).json({ ok: false, error: e.message }); }
});
// Список сотрудников для выбора участников собрания (bitrix id + имя).
router.get('/rooms/people', requireAuth(), async (req, res) => {
  try {
    const { USERS } = require('../constants');
    const people = Object.entries(USERS || {}).filter(([id]) => id !== '1')
      .map(([id, name]) => ({ id: Number(id), name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    res.json({ ok: true, people });
  } catch (e) { res.json({ ok: true, people: [] }); }
});
// Отменить бронь (свою; админ — любую).
router.delete('/rooms/book/:id', requireAuth(), async (req, res) => {
  await ensureRooms();
  try {
    const id = parseInt(req.params.id, 10);
    const cur = await pool.query(`SELECT user_id FROM ticketsmodule_room_bookings WHERE id=$1`, [id]);
    if (!cur.rows.length) return res.json({ ok: true });
    if (cur.rows[0].user_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ ok: false, error: 'Можно отменять только свою бронь' });
    await pool.query(`DELETE FROM ticketsmodule_room_bookings WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: 'Ошибка' }); }
});
// Управление переговорными (админ): список/добавить/изменить.
router.get('/rooms/manage', requireAuth(), async (req, res) => { await ensureRooms(); const r = await pool.query(`SELECT id,name,building,color,active,position FROM ticketsmodule_calendar_rooms ORDER BY position,id`); res.json({ ok: true, rooms: r.rows, canEdit: isAdmin(req) }); });
router.post('/rooms/manage', requireAuth(), express.json(), async (req, res) => { await ensureRooms(); if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Только администратор' }); try { const b = req.body || {}; const name = String(b.name || '').trim().slice(0, 200); if (!name) return res.status(400).json({ ok: false, error: 'Нужно название' }); const color = /^#[0-9a-fA-F]{6}$/.test(b.color || '') ? b.color : '#2f6bed'; const p = await pool.query(`SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_calendar_rooms`); const r = await pool.query(`INSERT INTO ticketsmodule_calendar_rooms (name,building,color,position) VALUES ($1,$2,$3,$4) RETURNING id`, [name, String(b.building || '').slice(0, 200), color, p.rows[0].p]); res.json({ ok: true, id: r.rows[0].id }); } catch (e) { res.status(500).json({ ok: false, error: 'Ошибка' }); } });
router.patch('/rooms/manage/:id', requireAuth(), express.json(), async (req, res) => { await ensureRooms(); if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Только администратор' }); try { const id = parseInt(req.params.id, 10); const b = req.body || {}; const sets = [], vals = []; let n = 1; if (typeof b.name === 'string') { sets.push(`name=$${n++}`); vals.push(b.name.slice(0, 200)); } if (typeof b.building === 'string') { sets.push(`building=$${n++}`); vals.push(b.building.slice(0, 200)); } if (/^#[0-9a-fA-F]{6}$/.test(b.color || '')) { sets.push(`color=$${n++}`); vals.push(b.color); } if ('active' in b) { sets.push(`active=$${n++}`); vals.push(!!b.active); } if (!sets.length) return res.json({ ok: true }); vals.push(id); await pool.query(`UPDATE ticketsmodule_calendar_rooms SET ${sets.join(', ')} WHERE id=$${n}`, vals); res.json({ ok: true }); } catch (e) { res.status(500).json({ ok: false, error: 'Ошибка' }); } });
// Разовый импорт существующих броней Bitrix «Conference room» в комнату ЦУП (админ).
router.post('/rooms/import-bitrix', requireAuth(), express.json(), async (req, res) => {
  await ensureRooms();
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Только администратор' });
  try {
    const rid = parseInt(req.body && req.body.roomId, 10);
    if (!rid) return res.status(400).json({ ok: false, error: 'Укажите комнату ЦУП (roomId) для импорта' });
    const { b24 } = require('../bitrix');
    const pd = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 19);
    const r = await b24('calendar.event.get', { type: 'location', ownerId: 0, from: req.body.from || pd(-150), to: req.body.to || pd(200) });
    const evs = (r && r.result) || [];
    let added = 0, skipped = 0;
    for (const ev of (Array.isArray(evs) ? evs : [])) {
      const bxId = String(ev.ID || ''); const tsF = +ev.DATE_FROM_TS_UTC, tsT = +ev.DATE_TO_TS_UTC;
      if (!bxId || !tsF || !tsT) { skipped++; continue; }
      try {
        const ins = await pool.query(
          `INSERT INTO ticketsmodule_room_bookings (room_id,title,booker_name,start_at,end_at,source,bitrix_event_id)
           VALUES ($1,$2,$3, to_timestamp($4), to_timestamp($5),'bitrix',$6)
           ON CONFLICT (bitrix_event_id) DO NOTHING RETURNING id`,
          [rid, String(ev.NAME || 'Бронь').slice(0, 300), String(ev.NAME || '').slice(0, 200), tsF, tsT, bxId]);
        if (ins.rows.length) added++; else skipped++;
      } catch (e) { skipped++; }
    }
    res.json({ ok: true, added, skipped, total: (evs || []).length });
  } catch (e) { console.error('rooms import:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
// Сырой ответ Bitrix для диагностики сопоставления переговорных (только админ).
// Пробуем батарею методов, чтобы точно понять, как заведены переговорные.
router.get('/rooms/raw', requireAuth(), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { b24 } = require('../bitrix');
  const out = {};
  const pd = n => { const d = new Date(Date.now() + n * 864e5); return d.toISOString().slice(0, 19); };
  const from = pd(-30), to = pd(30);
  async function probe(key, method, params) { try { const r = await b24(method, params); out[key] = (r && r.result !== undefined) ? r.result : r; } catch (e) { out[key + '_err'] = e.message; } }
  await probe('resource_list', 'calendar.resource.list', {});
  await probe('section_location', 'calendar.section.get', { type: 'location', ownerId: 0 });
  await probe('event_location', 'calendar.event.get', { type: 'location', ownerId: 0, from, to });
  await probe('rt_list', 'calendar.resource.type.list', {});
  await probe('booking_all', 'calendar.resource.booking.list', { filter: { resourceTypeIdList: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], from, to } });
  await probe('meeting_rooms', 'calendar.meeting.room.list', {});
  res.json({ ok: true, from, to, out });
});

// Ручной форс-синк «Экспо» с Б24 (админ) — для кнопки «обновить» и диагностики.
router.post('/rooms/sync-expo', requireAuth(), express.json(), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Только администратор' });
  try { res.json(await syncBitrixExpo()); }
  catch (e) { console.error('sync-expo:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});
// ВРЕМЕННО (диагностика): подобрать payload создания брони+участников в Б24.
// body: { fields:{...} } → calendar.event.add; { del:<id> } → calendar.event.delete.
router.post('/rooms/bx-test', requireAuth(), express.json(), async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { b24 } = require('../bitrix');
  try {
    const b = req.body || {};
    if (b.del) { const r = await b24('calendar.event.delete', { id: b.del }); return res.json({ ok: true, deleted: b.del, result: r && r.result }); }
    if (b.get) { const r = await b24('calendar.event.getbyid', { id: b.get }); return res.json({ ok: true, result: r && r.result }); }
    const r = await b24('calendar.event.add', b.fields || {});
    res.json({ ok: true, result: r && r.result });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router, bookRoom, listRooms, roomBookings, syncBitrixExpo, createRoomBooking };

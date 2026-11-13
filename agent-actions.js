// Пишущие действия агента ЦУП с ОБЯЗАТЕЛЬНЫМ подтверждением инициатора.
// Агент НЕ выполняет запись сам: он создаёт ПРЕДЛОЖЕНИЕ (propose), пользователь
// подтверждает (confirm) — и только тогда сервер выполняет действие под учёткой
// инициатора и пишет в аудит. Поддержанные типы: задача Bitrix, комментарий к
// сделке Bitrix, напоминание в ЦУП.
const { pool } = require('./auth');
const crypto = require('crypto');

let _ready = false;
async function ensure() {
  if (_ready) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_agent_actions (
      id SERIAL PRIMARY KEY,
      token VARCHAR(40) UNIQUE NOT NULL,
      user_id INTEGER,
      bitrix_user_id VARCHAR(32),
      kind VARCHAR(40) NOT NULL,
      params JSONB,
      summary TEXT,
      status VARCHAR(16) DEFAULT 'pending',
      result TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      done_at TIMESTAMPTZ
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_agent_reminders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      title VARCHAR(300),
      note TEXT,
      due_date DATE,
      done BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    _ready = true;
  } catch (e) { console.error('agent-actions schema:', e.message); }
}
ensure();

function tok() { return crypto.randomBytes(12).toString('hex'); }

// Сохранить ПРЕДЛОЖЕНИЕ (ничего не выполняя). Возвращает {token, summary, kind, params}.
async function propose(user, kind, params, summary) {
  await ensure();
  const token = tok();
  await pool.query(
    `INSERT INTO ticketsmodule_agent_actions (token, user_id, bitrix_user_id, kind, params, summary, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
    [token, user && user.id, user && user.bitrix_user_id, kind, JSON.stringify(params || {}), summary || '']);
  return { token, summary: summary || '', kind, params: params || {} };
}

// Выполнить ПОДТВЕРЖДЁННОЕ действие. Выполнить может ТОЛЬКО инициатор.
async function confirm(token, user) {
  await ensure();
  const r = await pool.query('SELECT * FROM ticketsmodule_agent_actions WHERE token=$1', [token]);
  if (!r.rows.length) return { ok: false, error: 'Действие не найдено' };
  const a = r.rows[0];
  if (a.user_id !== (user && user.id)) return { ok: false, error: 'Подтвердить действие может только инициатор' };
  if (a.status === 'done') return { ok: true, already: true, result: a.result };
  if (a.status === 'cancelled') return { ok: false, error: 'Действие было отменено' };
  const params = typeof a.params === 'string' ? JSON.parse(a.params) : (a.params || {});
  try {
    const result = await execute(a.kind, params, user);
    await pool.query(`UPDATE ticketsmodule_agent_actions SET status='done', result=$1, done_at=NOW() WHERE token=$2`, [result, token]);
    try { const { auditLog } = require('./auth'); await auditLog(user.id, user.username, 'AGENT_ACTION_' + String(a.kind).toUpperCase(), null, { params, result }, null, null); } catch (e) {}
    return { ok: true, result };
  } catch (e) {
    await pool.query(`UPDATE ticketsmodule_agent_actions SET status='error', result=$1 WHERE token=$2`, ['Ошибка: ' + e.message, token]);
    return { ok: false, error: e.message };
  }
}

async function cancel(token, user) {
  await ensure();
  await pool.query(`UPDATE ticketsmodule_agent_actions SET status='cancelled' WHERE token=$1 AND user_id=$2 AND status='pending'`, [token, user && user.id]);
  return { ok: true };
}

// Реальное выполнение записи. Выполняется под учёткой инициатора.
async function execute(kind, params, user) {
  const { b24 } = require('./bitrix');
  const bid = user && user.bitrix_user_id;
  if (kind === 'create_task') {
    const title = String(params.title || 'Задача').slice(0, 250);
    const descr = String(params.description || '');
    const deadline = params.deadline || null;
    const respBid = params.responsible_bid || bid || undefined;

    // 1) Задача в Bitrix (не фатально: если прав нет — хотя бы в ЦУП появится)
    let bitrixPart = '';
    if (respBid) {
      try {
        const fields = { TITLE: title, DESCRIPTION: descr, RESPONSIBLE_ID: respBid, CREATED_BY: bid || undefined };
        if (deadline) fields.DEADLINE = deadline;
        const r = await b24('tasks.task.add', { fields });
        const t = r && r.result && r.result.task;
        const id = t && (t.id || t.ID);
        bitrixPart = 'в Bitrix' + (id ? (' (ID ' + id + ')') : '');
      } catch (e) {
        bitrixPart = 'в Bitrix не удалось (' + String(e.message || e).slice(0, 60) + ')';
      }
    } else {
      bitrixPart = 'в Bitrix пропущено (нет ответственного с Bitrix-id)';
    }

    // 2) Карточка на доске ЦУП «Мои задачи» (ticketsmodule_board_cards)
    let boardPart = '';
    try {
      // ЦУП user_id ответственного: по его Bitrix-id, иначе — инициатор
      let targetUid = user && user.id;
      if (params.responsible_bid) {
        try {
          const ur = await pool.query('SELECT id FROM ticketsmodule_users WHERE bitrix_user_id=$1 LIMIT 1', [String(params.responsible_bid)]);
          if (ur.rows.length) targetUid = ur.rows[0].id;
        } catch (e) {}
      }
      if (targetUid) {
        const pr = await pool.query(
          `SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_board_cards WHERE user_id=$1 AND column_key='todo' AND archived=FALSE`,
          [targetUid]);
        const pos = pr.rows[0].p;
        const assignedBy = (targetUid !== (user && user.id)) ? (user && user.id) : null;
        await pool.query(
          `INSERT INTO ticketsmodule_board_cards (user_id, column_key, title, notes, due_date, position, assigned_by)
           VALUES ($1,'todo',$2,$3,$4,$5,$6)`,
          [targetUid, title, descr || null, deadline, pos, assignedBy]);
        boardPart = 'в «Мои задачи» ЦУП';
      }
    } catch (e) {
      console.error('board card from agent task:', e.message);
    }

    const parts = [bitrixPart, boardPart].filter(Boolean);
    return 'Задача создана ' + parts.join(' и ') + ': «' + title + '»';
  }
  if (kind === 'add_deal_comment') {
    const did = parseInt(params.deal_id, 10);
    if (!did) throw new Error('Не указан ID сделки');
    const comment = String(params.comment || '').trim();
    if (!comment) throw new Error('Пустой комментарий');
    await b24('crm.timeline.comment.add', { fields: { ENTITY_ID: did, ENTITY_TYPE: 'deal', COMMENT: comment } });
    return 'Комментарий добавлен к сделке ' + did;
  }
  if (kind === 'create_reminder') {
    await pool.query(`INSERT INTO ticketsmodule_agent_reminders (user_id, title, note, due_date) VALUES ($1,$2,$3,$4)`,
      [user && user.id, String(params.title || '').slice(0, 300), String(params.note || ''), params.due_date || null]);
    return 'Напоминание создано в ЦУП: «' + (params.title || '') + '»';
  }
  if (kind === 'create_event') {
    const title = String(params.title || 'Событие').slice(0, 500);
    const rawS = String(params.start || '');
    if (!/^\d{4}-\d{2}-\d{2}/.test(rawS)) throw new Error('Не указана дата события');
    const allDay = !!params.allDay || !/T\d{2}:\d{2}/.test(rawS);
    let startVal, endVal;
    if (allDay) {
      const sd = rawS.slice(0, 10);
      const ed = /^\d{4}-\d{2}-\d{2}/.test(String(params.end || '')) ? String(params.end).slice(0, 10) : sd;
      startVal = sd + 'T00:00'; endVal = ed + 'T00:00';
    } else {
      startVal = rawS.slice(0, 16);
      endVal = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(params.end || '')) ? String(params.end).slice(0, 16) : startVal;
    }
    const cat = ['meet', 'task', 'imp', 'agent'].includes(params.category) ? params.category : 'meet';
    await pool.query(
      `INSERT INTO ticketsmodule_calendar_events (owner_id, title, category, start_at, end_at, all_day, location, note, source, created_by)
       VALUES ($1,$2,$3, ($4)::timestamp AT TIME ZONE 'Asia/Almaty', ($5)::timestamp AT TIME ZONE 'Asia/Almaty', $6,$7,$8,'agent',$9)`,
      [user && user.id, title, cat, startVal, endVal, allDay, String(params.location || '').slice(0, 300), String(params.note || '').slice(0, 2000), (user && user.username) || 'agent']);
    return 'Событие добавлено в календарь ЦУП: «' + title + '»' + (allDay ? (' на ' + startVal.slice(0, 10)) : (' ' + startVal.slice(0, 10) + ' ' + startVal.slice(11, 16)));
  }
  if (kind === 'create_room_booking') {
    const cal = require('./routes/calendar-routes');
    const re = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    if (!re.test(String(params.start || '')) || !re.test(String(params.end || ''))) throw new Error('Нужны дата и время начала и конца');
    if (String(params.end).slice(0, 16) <= String(params.start).slice(0, 16)) throw new Error('Конец должен быть позже начала');
    let rid = params.room_id;
    let rooms = [];
    try { rooms = await cal.listRooms(); } catch (e) {}
    if (!rid && params.room_name) { const m = rooms.find(r => r.name.toLowerCase().includes(String(params.room_name).toLowerCase())); if (m) rid = m.rid; }
    if (!rid && rooms.length) rid = rooms[0].rid;
    if (!rid) throw new Error('Не удалось определить переговорную');
    // bookRoom сам проверяет пересечение и бросает «…занята»
    const id = await cal.bookRoom(rid, params.title, params.start, params.end, user);
    const rm = rooms.find(r => r.rid === rid);
    return 'Переговорная' + (rm ? (' «' + rm.name + '»') : '') + ' забронирована: ' + String(params.start).replace('T', ' ') + ' – ' + String(params.end).slice(11, 16);
  }
  throw new Error('Неизвестный тип действия: ' + kind);
}

module.exports = { propose, confirm, cancel, ensure };

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
    const fields = {
      TITLE: String(params.title || 'Задача').slice(0, 250),
      DESCRIPTION: String(params.description || ''),
      RESPONSIBLE_ID: params.responsible_bid || bid || undefined,
      CREATED_BY: bid || undefined,
    };
    if (params.deadline) fields.DEADLINE = params.deadline;
    if (!fields.RESPONSIBLE_ID) throw new Error('Не удалось определить ответственного (нет Bitrix-id)');
    const r = await b24('tasks.task.add', { fields });
    const t = r && r.result && r.result.task;
    const id = t && (t.id || t.ID);
    return 'Задача создана в Bitrix' + (id ? (' (ID ' + id + ')') : '') + ': «' + fields.TITLE + '»';
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
  throw new Error('Неизвестный тип действия: ' + kind);
}

module.exports = { propose, confirm, cancel, ensure };

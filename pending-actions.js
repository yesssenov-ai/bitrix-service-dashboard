// Агрегатор «действий, которые нужно сделать» пользователю — по всем модулям.
// Источники: закупки (локальная таблица) + задачи Bitrix, назначенные на
// пользователя. Легко расширяется — добавь источник в pendingForBid().
const { b24 } = require('./bitrix');

// Кол-во активных задач Bitrix, где пользователь — ответственный (то, что «надо
// сделать»). Считаем статусы 2 (ждёт выполнения) и 3 (выполняется). Завершённые
// (5), на контроле (4) и отклонённые (7) — не считаем.
async function bitrixTaskCount(bid) {
  if (!bid) return 0;
  try {
    const res = await b24('tasks.task.list', {
      filter: { RESPONSIBLE_ID: bid, STATUS: [2, 3], ZOMBIE: 'N' },
      select: ['ID'], start: 0,
    });
    if (res && res.total != null) return Number(res.total) || 0;
    const tasks = (res && res.result && res.result.tasks) || [];
    return tasks.length;
  } catch (e) { return 0; }
}

// Непрочитанные сообщения мессенджера для сотрудника (по его Bitrix-id).
// Это «красная цифра новых сообщений» — считается для всех, онлайн или нет.
async function msgUnreadForBid(bid) {
  try {
    const { pool } = require('./auth');
    const u = await pool.query('SELECT id FROM ticketsmodule_users WHERE bitrix_user_id=$1 AND active=true LIMIT 1', [bid]);
    if (!u.rows.length) return 0;
    const uid = u.rows[0].id;
    const r = await pool.query(`
      SELECT COALESCE(SUM((
        SELECT COUNT(*) FROM ticketsmodule_msg_messages x
        WHERE x.channel_id = m.channel_id AND x.id > m.last_read_id AND x.deleted_at IS NULL
          AND (x.author_id IS NULL OR x.author_id <> $1))), 0)::int AS n
      FROM ticketsmodule_msg_members m
      JOIN ticketsmodule_msg_channels c ON c.id = m.channel_id AND c.archived = false
      WHERE m.user_id = $1`, [uid]);
    return r.rows[0].n || 0;
  } catch (e) { return 0; }
}

// Итоговое число невыполненных действий пользователя + разбивка по источникам.
async function pendingForBid(bid) {
  bid = bid ? String(bid) : '';
  if (!bid) return { count: 0, breakdown: {}, items: [] };
  let proc = { count: 0, items: [] };
  try { proc = await require('./procurement-calc').pendingActionsFor(bid); } catch (e) { /* best-effort */ }
  let tasks = 0;
  try { tasks = await bitrixTaskCount(bid); } catch (e) { /* best-effort */ }
  let messages = 0;
  try { messages = await msgUnreadForBid(bid); } catch (e) { /* best-effort */ }
  const count = (proc.count || 0) + (tasks || 0) + (messages || 0);
  return {
    count,
    breakdown: { procurement: proc.count || 0, tasks: tasks || 0, messages: messages || 0 },
    items: proc.items || [],
  };
}

module.exports = { pendingForBid, bitrixTaskCount, msgUnreadForBid };

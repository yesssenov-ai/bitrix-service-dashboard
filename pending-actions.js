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

// Итоговое число невыполненных действий пользователя + разбивка по источникам.
async function pendingForBid(bid) {
  bid = bid ? String(bid) : '';
  if (!bid) return { count: 0, breakdown: {}, items: [] };
  let proc = { count: 0, items: [] };
  try { proc = await require('./procurement-calc').pendingActionsFor(bid); } catch (e) { /* best-effort */ }
  let tasks = 0;
  try { tasks = await bitrixTaskCount(bid); } catch (e) { /* best-effort */ }
  const count = (proc.count || 0) + (tasks || 0);
  return {
    count,
    breakdown: { procurement: proc.count || 0, tasks: tasks || 0 },
    items: proc.items || [],
  };
}

module.exports = { pendingForBid, bitrixTaskCount };

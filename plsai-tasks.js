// ProLab AI — сделки с актуальными (незакрытыми) задачами Bitrix. По модулю
// «Реализация» (ticketsmodule_operational_deals) или «План продаж»
// (ticketsmodule_stat_deals, доконтрактные стадии). Просроченные выделяются
// отдельно. Для дальнейшей рассылки ответственным, чтобы закрыли задачи.
const XLSX = require('xlsx');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');
const { b24 } = require('./bitrix');
const { PRECONTRACT } = require('./plsai-calc');
const { DEPARTMENT_LABELS } = require('./plsai-analytics');

// Актуальная = не закрытая: STATUS 1 (новая), 2 (ждёт), 3 (выполняется).
// Завершённые (5), ждёт контроля (4), отложенные (6), отклонённые (7) — не считаем.
const OPEN_STATUSES = [1, 2, 3];
const STATUS_LABELS = { 1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена' };
const DEAL_CAP = 1000;

function looksLikeTasks(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  // Запрос именно про ЗАДАЧИ (а не отгрузку/поставку).
  return /задач/.test(q) && (
    /актуальн[а-яё]* задач|незакрыт[а-яё]* задач|не закрыт[а-яё]* задач|открыт[а-яё]* задач|невыполненн[а-яё]* задач|просроч[а-яё]* задач|висящ[а-яё]* задач|активн[а-яё]* задач|с задач|есть задач|задачи по сделк|задач[а-яё]* в битрикс/.test(q)
  );
}
// По какому модулю искать: «План продаж» → sale; иначе (в т.ч. «Реализация») → ops.
function detectModule(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  if (/план[а-яё]*\s*продаж|плане продаж|доконтракт/.test(q)) return 'sale';
  return 'ops';
}
function wantsOverdueOnly(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /просроч/.test(q) && !/актуальн|незакрыт|не закрыт|открыт|все задач|с задач/.test(q);
}

// Открытые задачи по списку сделок одним пакетом (batch, до 50 команд за вызов).
async function openTasksForDeals(dealIds) {
  const ids = [...new Set((dealIds || []).map(x => parseInt(x, 10)).filter(Boolean))].slice(0, DEAL_CAP);
  const byDeal = {};
  const selects = ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'DEADLINE', 'CREATED_DATE'];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const cmd = {};
    chunk.forEach((id, k) => {
      const parts = [`tasks.task.list?filter[UF_CRM_TASK]=D_${id}`];
      OPEN_STATUSES.forEach((s, si) => parts.push(`filter[STATUS][${si}]=${s}`));
      selects.forEach((s, si) => parts.push(`select[${si}]=${s}`));
      cmd['t' + k] = parts.join('&');
    });
    let res;
    try { res = await b24('batch', { halt: 0, cmd }); } catch (e) { res = null; }
    const sub = res && res.result && res.result.result;
    if (!sub) continue;
    chunk.forEach((id, k) => {
      const r = sub['t' + k];
      const tasks = (r && (r.tasks || r)) || [];
      byDeal[id] = Array.isArray(tasks) ? tasks : [];
    });
  }
  return byDeal;
}

function normTask(t) {
  const status = parseInt(t.status ?? t.STATUS, 10);
  const deadline = t.deadline ?? t.DEADLINE ?? null;
  const respId = parseInt(t.responsibleId ?? t.RESPONSIBLE_ID, 10) || null;
  const dlMs = deadline ? new Date(deadline).getTime() : null;
  const overdue = dlMs != null && dlMs < Date.now();
  const overdueDays = overdue ? Math.floor((Date.now() - dlMs) / 86400000) : null;
  return {
    id: t.id ?? t.ID, title: (t.title ?? t.TITLE ?? '').toString(),
    status, statusLabel: STATUS_LABELS[status] || ('статус ' + status),
    responsibleId: respId, responsible: respId ? (USERS[respId] || ('#' + respId)) : '—',
    deadline: deadline ? String(deadline).slice(0, 10) : null, overdue, overdueDays,
  };
}

async function runTasks(qRaw) {
  const module = detectModule(qRaw);
  const overdueOnly = wantsOverdueOnly(qRaw);
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  let dealRows;
  if (module === 'sale') {
    const r = await pool.query(
      `SELECT deal_id, company_name, assigned_by_id, department_id, stage_id, (${kzt}) v
       FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) ORDER BY (${kzt}) DESC LIMIT ${DEAL_CAP}`, [PRECONTRACT]);
    dealRows = r.rows;
  } else {
    const r = await pool.query(
      `SELECT deal_id, company_name, assigned_by_id, department_id, stage_id, (${kzt}) v
       FROM ticketsmodule_operational_deals ORDER BY (${kzt}) DESC LIMIT ${DEAL_CAP}`);
    dealRows = r.rows;
  }
  const byDeal = await openTasksForDeals(dealRows.map(r => r.deal_id));
  const items = [];
  for (const r of dealRows) {
    const raw = byDeal[r.deal_id] || [];
    if (!raw.length) continue;
    let tasks = raw.map(normTask);
    if (overdueOnly) tasks = tasks.filter(t => t.overdue);
    if (!tasks.length) continue;
    tasks.sort((a, b) => (b.overdue - a.overdue) || ((a.deadline || '9999') > (b.deadline || '9999') ? 1 : -1));
    const overdueCount = tasks.filter(t => t.overdue).length;
    items.push({
      dealId: r.deal_id, company: r.company_name || '', manager: USERS[r.assigned_by_id] || '', managerId: r.assigned_by_id,
      dept: DEPARTMENT_LABELS[r.department_id] || '', sumKzt: Math.round(parseFloat(r.v) || 0),
      openCount: tasks.length, overdueCount, hasOverdue: overdueCount > 0, tasks,
    });
  }
  // Сортировка: сначала с просрочкой, затем по числу открытых, затем по сумме.
  items.sort((a, b) => (b.hasOverdue - a.hasOverdue) || (b.overdueCount - a.overdueCount) || (b.openCount - a.openCount) || (b.sumKzt - a.sumKzt));
  const taskTotal = items.reduce((s, x) => s + x.openCount, 0);
  const overdueTotal = items.reduce((s, x) => s + x.overdueCount, 0);
  return {
    tasks: true, module, moduleLabel: module === 'sale' ? 'План продаж' : 'Реализация', overdueOnly,
    dealCount: items.length, taskCount: taskTotal, overdueCount: overdueTotal,
    sumKzt: items.reduce((s, x) => s + x.sumKzt, 0), rows: items,
  };
}

// Excel: одна строка на задачу (чтобы разослать ответственным).
function buildTasksXlsx(res) {
  const header = ['Компания', 'Отдел', 'Менеджер сделки', 'Задача', 'Ответственный', 'Статус', 'Дедлайн', 'Просрочена', 'Дней просрочки', 'Сумма сделки (₸)', 'ID сделки', 'ID задачи'];
  const aoa = [header];
  for (const d of res.rows) {
    for (const t of d.tasks) {
      aoa.push([d.company, d.dept, d.manager, t.title, t.responsible, t.statusLabel, t.deadline || '—',
        t.overdue ? 'да' : '', t.overdueDays == null ? '' : t.overdueDays, d.sumKzt, d.dealId, t.id]);
    }
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [38, 16, 20, 48, 20, 16, 12, 11, 13, 16, 10, 10].map(w => ({ wch: w }));
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, res.overdueOnly ? 'Просроченные задачи' : 'Актуальные задачи');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { looksLikeTasks, detectModule, runTasks, buildTasksXlsx, openTasksForDeals };

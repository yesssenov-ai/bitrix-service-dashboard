// ProLab AI — трекер задач Bitrix по сделкам: КТО и КАК выполняет.
// Сценарий: на оперативке ставятся задачи ответственным; здесь видно по каждому
// исполнителю — сколько задач, сколько выполнено / открыто / просрочено, и сам список.
// Модуль «Реализация» (ticketsmodule_operational_deals) или «План продаж»
// (ticketsmodule_stat_deals, доконтрактные) либо оба.
const XLSX = require('xlsx');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');
const { b24 } = require('./bitrix');
const { PRECONTRACT } = require('./plsai-calc');
const { DEPARTMENT_LABELS } = require('./plsai-analytics');

const OPEN_STATUSES = [1, 2, 3, 4, 6];   // не закрытые (новая/ждёт/выполняется/ждёт контроля/отложена)
const DONE_STATUS = 5;                    // завершена
const DECLINED_STATUS = 7;                // отклонена
const STATUS_LABELS = { 1: 'Новая', 2: 'Ждёт выполнения', 3: 'Выполняется', 4: 'Ждёт контроля', 5: 'Завершена', 6: 'Отложена', 7: 'Отклонена' };
const DEAL_CAP = 1500;

// Отделы (department_id) и их алиасы для фильтра «по сделкам <отдела>».
const DEPT_ALIASES = {
  'элементн': ['4857'], 'хроматограф': ['4858'], 'электрохим': ['4859'], 'клеточн': ['4860'],
  'орм': ['4862'], 'расходник': ['4862'], 'сервис': ['4863'], 'тренинг': ['4864'], 'обучен': ['4864'],
  'general lab': ['4865'], 'общелаб': ['4865'], 'материаловед': ['8384'], 'комплекс': ['4866'],
};
function detectDepts(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  for (const [k, ids] of Object.entries(DEPT_ALIASES)) if (q.includes(k)) return { ids, label: DEPARTMENT_LABELS[ids[0]] || ids[0] };
  return { ids: null, label: null };
}
function detectManagers(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  const out = [];
  for (const [id, name] of Object.entries(USERS)) {
    if (!name) continue;
    const parts = String(name).toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    if (parts.some(p => q.includes(p))) out.push({ id: Number(id), name });
  }
  return out;
}

function looksLikeTasks(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /задач/.test(q) && (
    /актуальн[а-яё]* задач|незакрыт[а-яё]* задач|не закрыт[а-яё]* задач|открыт[а-яё]* задач|невыполненн[а-яё]* задач|просроч[а-яё]* задач|висящ[а-яё]* задач|активн[а-яё]* задач|с задач|есть задач|задачи по сделк|задач[а-яё]* в битрикс|выполня[а-яё]* задач|задач[а-яё]* выполня|кто выполня|выполнени[ея] задач|статус[а-яё]* задач|трекер задач|по исполнител|кто (не )?закрыл|с оперативк|с митинг|поставил задач|поставленн[а-яё]* задач/.test(q)
  );
}
// Модуль: оба / План продаж / Реализация.
function detectModule(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  const sale = /план[а-яё]*\s*продаж|плане продаж|доконтракт/.test(q);
  const ops = /реализац|операционн|исполнени|оперативк|митинг/.test(q);
  if ((sale && ops) || /везде|во всех модул|по всем модул|по всем сделк|во всех сделк|по всей компан|все отдел|всех отдел/.test(q)) return 'both';
  if (sale && !ops) return 'sale';
  return 'ops';
}
function wantsOverdueOnly(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /просроч/.test(q) && !/актуальн|незакрыт|не закрыт|открыт|все задач|с задач|выполня|как кто|по исполнител/.test(q);
}
function wantsOpenOnly(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  // Явно про «актуальные/открытые/незакрытые» и НЕ про выполнение/кто как — тогда прячем завершённые.
  return /актуальн[а-яё]* задач|незакрыт[а-яё]* задач|не закрыт[а-яё]* задач|открыт[а-яё]* задач/.test(q) && !/выполня|как кто|по исполнител|статус|трекер|все задач/.test(q);
}

// Задачи по списку сделок пакетом (batch). statuses=null → все статусы.
async function tasksForDeals(dealIds, statuses) {
  const ids = [...new Set((dealIds || []).map(x => parseInt(x, 10)).filter(Boolean))].slice(0, DEAL_CAP);
  const byDeal = {};
  const selects = ['ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'CREATED_BY', 'DEADLINE', 'CREATED_DATE', 'CLOSED_DATE'];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const cmd = {};
    chunk.forEach((id, k) => {
      const parts = [`tasks.task.list?filter[UF_CRM_TASK]=D_${id}`];
      if (statuses && statuses.length) statuses.forEach((s, si) => parts.push(`filter[STATUS][${si}]=${s}`));
      selects.forEach((s, si) => parts.push(`select[${si}]=${s}`));
      cmd['t' + k] = parts.join('&');
    });
    let res; try { res = await b24('batch', { halt: 0, cmd }); } catch (e) { res = null; }
    const sub = res && res.result && res.result.result;
    if (!sub) continue;
    chunk.forEach((id, k) => { const r = sub['t' + k]; const tasks = (r && (r.tasks || r)) || []; byDeal[id] = Array.isArray(tasks) ? tasks : []; });
  }
  return byDeal;
}
// Для действий (рассылок) — только открытые.
async function openTasksForDeals(dealIds) { return tasksForDeals(dealIds, OPEN_STATUSES); }

function normTask(t, deal) {
  const status = parseInt(t.status ?? t.STATUS, 10);
  const deadline = t.deadline ?? t.DEADLINE ?? null;
  const respId = parseInt(t.responsibleId ?? t.RESPONSIBLE_ID, 10) || null;
  const creatorId = parseInt(t.createdBy ?? t.CREATED_BY, 10) || null;
  const closed = t.closedDate ?? t.CLOSED_DATE ?? null;
  const done = status === DONE_STATUS;
  const declined = status === DECLINED_STATUS;
  const dlMs = deadline ? new Date(deadline).getTime() : null;
  const overdue = !done && !declined && dlMs != null && dlMs < Date.now();
  const overdueDays = overdue ? Math.floor((Date.now() - dlMs) / 86400000) : null;
  return {
    id: t.id ?? t.ID, title: (t.title ?? t.TITLE ?? '').toString(),
    status, statusLabel: STATUS_LABELS[status] || ('статус ' + status), done, declined,
    responsibleId: respId, responsible: respId ? (USERS[respId] || ('#' + respId)) : '—',
    creatorId, creator: creatorId ? (USERS[creatorId] || ('#' + creatorId)) : '',
    deadline: deadline ? String(deadline).slice(0, 10) : null, closedDate: closed ? String(closed).slice(0, 10) : null,
    overdue, overdueDays,
    dealId: deal.deal_id, company: deal.company_name || '', dept: DEPARTMENT_LABELS[deal.department_id] || '', dealMgr: USERS[deal.assigned_by_id] || '',
  };
}

async function runTasks(qRaw, opts = {}) {
  const module = detectModule(qRaw);
  const overdueOnly = wantsOverdueOnly(qRaw);
  const openOnly = !overdueOnly && wantsOpenOnly(qRaw);
  const mineOnly = /мои задач|которые я поставил|мной поставл|я ставил|от меня\b/.test(String(qRaw || '').toLowerCase());
  const meBid = opts.meBid || null;
  const dep = detectDepts(qRaw);
  const managers = detectManagers(qRaw);
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  // Доп. фильтры по отделу / менеджеру сделки. Возвращает SQL-условия, дописывая params.
  function conds(params) {
    const w = [];
    if (dep.ids) { params.push(dep.ids); w.push(`department_id::text = ANY($${params.length})`); }
    if (managers.length) { params.push(managers.map(m => m.id)); w.push(`assigned_by_id = ANY($${params.length})`); }
    return w;
  }
  const saleParams = [PRECONTRACT]; const saleW = conds(saleParams);
  const saleSql = `SELECT deal_id, company_name, assigned_by_id, department_id, stage_id, (${kzt}) v
       FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1)${saleW.length ? ' AND ' + saleW.join(' AND ') : ''} ORDER BY (${kzt}) DESC LIMIT ${DEAL_CAP}`;
  const opsParams = []; const opsW = conds(opsParams);
  const opsSql = `SELECT deal_id, company_name, assigned_by_id, department_id, stage_id, (${kzt}) v
       FROM ticketsmodule_operational_deals${opsW.length ? ' WHERE ' + opsW.join(' AND ') : ''} ORDER BY (${kzt}) DESC LIMIT ${DEAL_CAP}`;
  let dealRows;
  if (module === 'sale') { dealRows = (await pool.query(saleSql, saleParams)).rows; }
  else if (module === 'both') {
    const [a, b] = await Promise.all([pool.query(saleSql, saleParams), pool.query(opsSql, opsParams)]);
    const seen = new Set(); dealRows = [];
    for (const r of [...a.rows, ...b.rows]) { if (seen.has(r.deal_id)) continue; seen.add(r.deal_id); dealRows.push(r); }
  } else { dealRows = (await pool.query(opsSql, opsParams)).rows; }

  const dealById = {}; dealRows.forEach(r => { dealById[r.deal_id] = r; });
  const byDeal = await tasksForDeals(dealRows.map(r => r.deal_id), null);

  // Собираем все задачи (с их сделками), фильтруем.
  let all = [];
  for (const r of dealRows) { for (const raw of (byDeal[r.deal_id] || [])) all.push(normTask(raw, r)); }
  all = all.filter(t => !t.declined);                        // отклонённые не показываем
  if (mineOnly && meBid) all = all.filter(t => t.creatorId === meBid);

  // Сводка по исполнителям (всегда по всем: и открытые, и выполненные — чтобы видеть «как выполняет»).
  const peopleMap = {};
  for (const t of all) {
    const key = t.responsibleId || 0;
    const p = peopleMap[key] || (peopleMap[key] = { responsibleId: t.responsibleId, responsible: t.responsible, assigned: 0, done: 0, open: 0, overdue: 0, tasks: [] });
    p.assigned++; if (t.done) p.done++; else p.open++; if (t.overdue) p.overdue++;
    p.tasks.push(t);
  }
  const people = Object.values(peopleMap).map(p => {
    p.pct = p.assigned ? Math.round(p.done / p.assigned * 100) : 0;
    p.tasks.sort((a, b) => (b.overdue - a.overdue) || (a.done - b.done) || ((a.deadline || '9999') > (b.deadline || '9999') ? 1 : -1));
    return p;
  }).sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open) || (b.assigned - a.assigned));

  // Набор задач для таблицы/выгрузки.
  let taskRows = all.slice();
  if (overdueOnly) taskRows = taskRows.filter(t => t.overdue);
  else if (openOnly) taskRows = taskRows.filter(t => !t.done);
  taskRows.sort((a, b) => (b.overdue - a.overdue) || (a.done - b.done) || ((a.deadline || '9999') > (b.deadline || '9999') ? 1 : -1));

  const totals = {
    people: people.length,
    deals: new Set(all.map(t => t.dealId)).size,
    tasks: all.length, done: all.filter(t => t.done).length, open: all.filter(t => !t.done).length, overdue: all.filter(t => t.overdue).length,
  };
  const baseLabel = module === 'sale' ? 'План продаж' : module === 'both' ? 'Все модули' : 'Реализация';
  const scopeParts = [];
  if (dep.label) scopeParts.push('отдел ' + dep.label);
  if (managers.length) scopeParts.push(managers.map(m => m.name).join(', '));
  return {
    tasks: true, module, moduleLabel: baseLabel + (scopeParts.length ? ' · ' + scopeParts.join(' · ') : ''),
    deptLabel: dep.label || null, managers: managers.map(m => m.name),
    overdueOnly, openOnly, mineOnly: mineOnly && !!meBid,
    totals, people, taskRows,
    actionable: { dealIds: [...new Set(taskRows.map(t => t.dealId))], mode: 'tasks' },
  };
}

// Excel: лист «Задачи» (строка на задачу) + лист «По исполнителям» (сводка).
function buildTasksXlsx(res) {
  const wb = XLSX.utils.book_new();
  const h1 = ['Исполнитель', 'Задача', 'Статус', 'Готово', 'Просрочена', 'Дней просрочки', 'Дедлайн', 'Дата закрытия', 'Постановщик', 'Компания', 'Отдел', 'Менеджер сделки', 'ID сделки', 'ID задачи'];
  const a1 = [h1, ...res.taskRows.map(t => [t.responsible, t.title, t.statusLabel, t.done ? 'да' : '', t.overdue ? 'да' : '', t.overdueDays == null ? '' : t.overdueDays, t.deadline || '—', t.closedDate || '', t.creator || '', t.company, t.dept, t.dealMgr, t.dealId, t.id])];
  const ws1 = XLSX.utils.aoa_to_sheet(a1); ws1['!cols'] = [20, 48, 16, 8, 11, 13, 12, 12, 18, 34, 16, 20, 10, 10].map(w => ({ wch: w })); ws1['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws1, 'Задачи');

  const h2 = ['Исполнитель', 'Всего', 'Выполнено', 'Открыто', 'Просрочено', '% выполнения'];
  const a2 = [h2, ...res.people.map(p => [p.responsible, p.assigned, p.done, p.open, p.overdue, p.pct])];
  const ws2 = XLSX.utils.aoa_to_sheet(a2); ws2['!cols'] = [24, 8, 12, 10, 12, 13].map(w => ({ wch: w })); ws2['!freeze'] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(wb, ws2, 'По исполнителям');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { looksLikeTasks, detectModule, runTasks, buildTasksXlsx, openTasksForDeals };

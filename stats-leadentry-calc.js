// «Эффективность / Заведение сделок»: статистика того, кто и на какой стадии
// ЗАВЁЛ сделку (впервые появилась в системе). Правило компании — заводить с P10;
// отчёт показывает, кто как заводит и сколько сделок заведено за период.
//
// Данные: первая по времени запись в ticketsmodule_stage_history по каждой сделке
// = стадия и дата ПЕРВОГО появления; автор = ticketsmodule_stat_deals.created_by_id.
const { pool } = require('./auth');
const { USERS } = require('./constants');

// Базовые стадии → шаг воронки (префикс категории C1:/C2:/C3: срезаем).
const STAGE_STEP = { NEW: 'P10', PREPARATION: 'P30', PREPAYMENT_INVOICE: 'P60', EXECUTING: 'P80' };
// Законтрактованные стадии (как в «Контрактах»/«Плане продаж») → шаг «Contract».
const CONTRACT = new Set(['FINAL_INVOICE', 'WON', '1', '2', '3',
  'UC_Q9J6VV', 'UC_9MBFR2', 'UC_3MVK90', 'UC_3SCB5K', 'UC_YYTFYG']);

function stageToStep(stageId) {
  if (!stageId) return null;
  const base = String(stageId).replace(/^C\d+:/, ''); // срезаем префикс категории
  if (STAGE_STEP[base]) return STAGE_STEP[base];
  if (CONTRACT.has(base)) return 'Contract';
  return null; // прочее (проигрыш/служебные) — не считаем «заведением»
}

async function getLeadEntry() {
  // Первая по времени запись истории стадий по каждой сделке + автор сделки.
  // Год/месяц берём в таймзоне Алматы, чтобы месяцы бились с остальными отчётами.
  const { rows } = await pool.query(`
    WITH fs AS (
      SELECT DISTINCT ON (deal_id) deal_id, stage_id, created_time
        FROM ticketsmodule_stage_history
       ORDER BY deal_id, created_time ASC
    )
    SELECT d.created_by_id AS creator,
           COALESCE(fs.stage_id, d.stage_id) AS stage_id,
           EXTRACT(YEAR  FROM (COALESCE(fs.created_time, d.date_create::timestamptz) AT TIME ZONE 'Asia/Almaty'))::int AS y,
           EXTRACT(MONTH FROM (COALESCE(fs.created_time, d.date_create::timestamptz) AT TIME ZONE 'Asia/Almaty'))::int AS m
      FROM ticketsmodule_stat_deals d
      LEFT JOIN fs ON fs.deal_id = d.deal_id
     WHERE d.created_by_id IS NOT NULL
       AND COALESCE(fs.created_time, d.date_create::timestamptz) IS NOT NULL
  `);

  const mgr = {};          // id -> имя
  const agg = {};          // "y|m|creator|step" -> count
  const yearsSet = new Set();
  for (const r of rows) {
    const step = stageToStep(r.stage_id);
    if (!step || !r.y || !r.m) continue;
    const cid = String(r.creator);
    if (!mgr[cid]) mgr[cid] = USERS[cid] || ('#' + cid);
    yearsSet.add(r.y);
    const k = r.y + '|' + (r.m - 1) + '|' + cid + '|' + step; // month 0..11
    agg[k] = (agg[k] || 0) + 1;
  }
  const rowsOut = Object.entries(agg).map(([k, n]) => {
    const [y, m, cid, step] = k.split('|');
    return { year: +y, month: +m, creator: cid, step, n };
  });
  const managers = Object.entries(mgr).map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const years = [...yearsSet].sort((a, b) => b - a);
  return { ok: true, rows: rowsOut, managers, years, steps: ['P10', 'P30', 'P60', 'P80', 'Contract'] };
}

module.exports = { getLeadEntry };

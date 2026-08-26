// ProLab AI — прогноз продаж на месяц. Считает ожидаемую сумму подписанных
// контрактов = уже подписано + взвешенная воронка (по стадиям P10/P30/P60/P80 =
// вероятности) со сделками, у которых планируемая покупка попадает в месяц.
// Плюс ориентиры: средний темп с начала года и этот же месяц прошлого года.
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { STEP_STAGES, PRECONTRACT, CONTRACT_SET } = require('./plsai-calc');

const STEP_PROB = { P10: 0.10, P30: 0.30, P60: 0.60, P80: 0.80 };
const MONTHS = { 'январ': 1, 'феврал': 2, 'март': 3, 'марте': 3, 'апрел': 4, 'мае': 5, 'май': 5, 'июн': 6, 'июл': 7, 'август': 8, 'авгус': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12 };
const MON_NAME = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function astanaNow() { return new Date(Date.now() + 5 * 3600000); }
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function shiftYear(dateStr, delta) { const p = String(dateStr).split('-'); return (parseInt(p[0], 10) + delta) + '-' + p[1] + '-' + p[2]; }

function stepOf(stageId) { for (const s of ['P80', 'P60', 'P30', 'P10']) if ((STEP_STAGES[s] || []).includes(stageId)) return s; return null; }

function looksLikeForecast(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /прогноз|спрогноз|предскаж|forecast|продад|подпиш[еёи]м|закро[еёи]м/.test(q)
    || /(ожида|вероятн|скольк)[а-яё]*.{0,40}(продаж|прода[дм]|подпиш|закро)/.test(q);
}

// Целевой месяц. По умолчанию — текущий месяц (Астана).
function detectForecastMonth(qRaw) {
  const now = astanaNow();
  const curY = now.getFullYear();
  const ql = String(qRaw || '').toLowerCase();
  let year = null;
  const ym = ql.match(/20\d\d/);
  if (ym) year = parseInt(ym[0], 10);
  else if (/прошл[а-яё]*\s*год/.test(ql)) year = curY - 1;
  let month = null;
  for (const [k, v] of Object.entries(MONTHS)) { if (ql.includes(k)) { month = v; break; } }
  if (/следующ[а-яё]*\s*месяц|будущ[а-яё]*\s*месяц/.test(ql)) { const d = new Date(curY, now.getMonth() + 1, 1); month = d.getMonth() + 1; year = year || d.getFullYear(); }
  if (!month) { month = now.getMonth() + 1; }   // текущий месяц по умолчанию
  const y = year || curY;
  return { year: y, month, from: ymd(y, month, 1), to: ymd(y, month, lastDay(y, month)), label: `${MON_NAME[month]} ${y}` };
}

async function runForecast(qRaw) {
  const rate = await getTodayRate();
  const per = detectForecastMonth(qRaw);
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const num = v => Math.round(parseFloat(v) || 0);

  // 1) Уже подписано в месяце (факт).
  const act = await pool.query(
    `SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`, [CONTRACT_SET, per.from, per.to]);
  const actual = { sum: num(act.rows[0].s), count: parseInt(act.rows[0].c, 10) };

  // 2) Взвешенная воронка: открытые сделки с планируемой покупкой в месяце.
  const pipe = await pool.query(
    `SELECT stage_id, likely_deal, (${kzt}) AS v FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND planned_purchase_date BETWEEN $2 AND $3`, [PRECONTRACT, per.from, per.to]);
  const buck = { P80: { s: 0, c: 0 }, P60: { s: 0, c: 0 }, early: { s: 0, c: 0 }, likely: { s: 0, c: 0 } };
  let weighted = 0, faceSum = 0;
  for (const r of pipe.rows) {
    const v = parseFloat(r.v) || 0; faceSum += v;
    const step = stepOf(r.stage_id); let p = STEP_PROB[step] || 0.2;
    if (r.likely_deal) { p = Math.max(p, 0.75); buck.likely.s += v; buck.likely.c++; }
    weighted += v * p;
    if (step === 'P80') { buck.P80.s += v; buck.P80.c++; }
    else if (step === 'P60') { buck.P60.s += v; buck.P60.c++; }
    else { buck.early.s += v; buck.early.c++; }
  }
  weighted = Math.round(weighted);
  for (const k of Object.keys(buck)) buck[k].s = Math.round(buck[k].s);

  // 3) Средний темп с начала года (Jan … начало целевого месяца).
  const rr = await pool.query(
    `SELECT COALESCE(SUM(${kzt}),0) s, COUNT(DISTINCT date_trunc('month', contract_date)) m
     FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date >= $2 AND contract_date < $3`,
    [CONTRACT_SET, `${per.year}-01-01`, per.from]);
  const rrMonths = parseInt(rr.rows[0].m, 10) || 0;
  const runRate = rrMonths ? Math.round(num(rr.rows[0].s) / rrMonths) : 0;

  // 4) Сезонность: тот же месяц прошлого года.
  const ly = await pool.query(
    `SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`,
    [CONTRACT_SET, shiftYear(per.from, -1), shiftYear(per.to, -1)]);
  const lastYear = { sum: num(ly.rows[0].s), count: parseInt(ly.rows[0].c, 10) };

  const point = actual.sum + weighted;
  const low = actual.sum + Math.round(buck.P80.s * 0.8);           // осторожно: только P80 (80%)
  const high = actual.sum + faceSum;                               // оптимистично: вся воронка закрылась
  return {
    forecast: true, period: per, estimate: { point, low, high },
    actual, weighted, pipeline: buck, faceSum: Math.round(faceSum),
    refs: { runRate, lastYear },
    hasPlanned: pipe.rows.length > 0,
  };
}

module.exports = { looksLikeForecast, runForecast };

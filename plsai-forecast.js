// ProLab AI — прогноз продаж на месяц (v2).
// Слои: (1) уже подписано; (2) взвешенная воронка по стадиям P10/P30/P60/P80 (=вероятности);
// (3) комментарии из Bitrix корректируют вероятность (на подписании → ↑, заморожено → ↓);
// (4) честный диапазон P10–P90 (нормальное приближение суммы независимых сделок);
// (5) ориентиры: темп с начала года, тот же месяц год назад, коэффициент сбычи планов;
// (6) ежедневный снимок воронки (копится для будущей калибровки по истории).
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { STEP_STAGES, PRECONTRACT, CONTRACT_SET } = require('./plsai-calc');

const STEP_PROB = { P10: 0.10, P30: 0.30, P60: 0.60, P80: 0.80 };
const P80_SET = STEP_STAGES.P80;
const MONTHS = { 'январ': 1, 'феврал': 2, 'март': 3, 'марте': 3, 'апрел': 4, 'мае': 5, 'май': 5, 'июн': 6, 'июл': 7, 'август': 8, 'авгус': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12 };
const MON_NAME = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// Сигналы в комментариях: близко к подписанию ↑ / застряло ↓ (без латинского \w — кириллица).
const NEAR_RE = /на подписани|подписыва|на согласовани|согласован[а-яё]* договор|договор[а-яё]* на согласован|сч[ёе]т выставл|выставил[а-яё]* сч[ёе]т|оплат[а-яё]* поступ|оплата получ|тендер выигра|выигра[а-яё]* тендер|гарантийн[а-яё]* письмо|подписал[а-яё]* договор|жд[ёе]м подписани|отправил[а-яё]* на подпис|готов[а-яё]* к подписани|подписание договор/;
const STALL_RE = /перенес|отлож|заморож|нет бюджет|бюджет не|проигра|отказ|отмен|сорвал|заглох|не выход[а-яё]* на связ|тишина|приостанов/;

function astanaNow() { return new Date(Date.now() + 5 * 3600000); }
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function shiftYear(s, delta) { const p = String(s).split('-'); return (parseInt(p[0], 10) + delta) + '-' + p[1] + '-' + p[2]; }
function stepOf(id) { for (const s of ['P80', 'P60', 'P30', 'P10']) if ((STEP_STAGES[s] || []).includes(id)) return s; return null; }

function looksLikeForecast(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /прогноз|спрогноз|предскаж|forecast|продад|подпиш[еёи]м|закро[еёи]м/.test(q)
    || /(ожида|вероятн|скольк)[а-яё]*.{0,40}(продаж|прода[дм]|подпиш|закро)/.test(q);
}

function detectForecastMonth(qRaw) {
  const now = astanaNow(); const curY = now.getFullYear();
  const ql = String(qRaw || '').toLowerCase();
  let year = null; const ym = ql.match(/20\d\d/);
  if (ym) year = parseInt(ym[0], 10); else if (/прошл[а-яё]*\s*год/.test(ql)) year = curY - 1;
  let month = null;
  for (const [k, v] of Object.entries(MONTHS)) { if (ql.includes(k)) { month = v; break; } }
  if (/следующ[а-яё]*\s*месяц|будущ[а-яё]*\s*месяц/.test(ql)) { const d = new Date(curY, now.getMonth() + 1, 1); month = d.getMonth() + 1; year = year || d.getFullYear(); }
  if (!month) month = now.getMonth() + 1;
  const y = year || curY;
  return { year: y, month, from: ymd(y, month, 1), to: ymd(y, month, lastDay(y, month)), label: `${MON_NAME[month]} ${y}` };
}

let _tablesReady = false;
async function ensureTables() {
  if (_tablesReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_plsai_comment_signal (
    deal_id INTEGER PRIMARY KEY, signal VARCHAR(12), snippet TEXT, checked_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_plsai_pipeline_snap (
    taken_on DATE, month VARCHAR(7), actual_sum BIGINT, weighted BIGINT, p60_sum BIGINT, p80_sum BIGINT,
    likely_sum BIGINT, planned_face BIGINT, PRIMARY KEY (taken_on, month))`);
  _tablesReady = true;
}

// Параллельная обработка с ограничением одновременных запросов.
async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (_) { out[idx] = null; } }
  });
  await Promise.all(workers);
  return out;
}

// Сигнал по комментариям одной сделки (кэш 6ч).
async function commentSignal(dealId) {
  try {
    const { rows } = await pool.query("SELECT signal, snippet FROM ticketsmodule_plsai_comment_signal WHERE deal_id=$1 AND checked_at > NOW() - INTERVAL '6 hours'", [dealId]);
    if (rows.length) return rows[0];
  } catch (_) {}
  let signal = 'neutral', snippet = '';
  try {
    const { b24 } = require('./bitrix');
    const { result } = await b24('crm.timeline.comment.list', { filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' }, order: { CREATED: 'DESC' }, select: ['COMMENT', 'CREATED'] });
    const texts = (result || []).slice(0, 6).map(c => String(c.COMMENT || ''));
    const joined = texts.join(' \n ').toLowerCase();
    if (NEAR_RE.test(joined)) { signal = 'near'; snippet = (texts.find(t => NEAR_RE.test(t.toLowerCase())) || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
    else if (STALL_RE.test(joined)) { signal = 'stall'; snippet = (texts.find(t => STALL_RE.test(t.toLowerCase())) || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
  } catch (_) { signal = 'neutral'; }
  try { await pool.query(`INSERT INTO ticketsmodule_plsai_comment_signal (deal_id,signal,snippet,checked_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (deal_id) DO UPDATE SET signal=$2,snippet=$3,checked_at=NOW()`, [dealId, signal, snippet]); } catch (_) {}
  return { signal, snippet };
}

async function runForecast(qRaw) {
  const rate = await getTodayRate();
  const per = detectForecastMonth(qRaw);
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const num = v => Math.round(parseFloat(v) || 0);
  try { await ensureTables(); } catch (_) {}

  // 1) Уже подписано в месяце.
  const act = await pool.query(`SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`, [CONTRACT_SET, per.from, per.to]);
  const actual = { sum: num(act.rows[0].s), count: parseInt(act.rows[0].c, 10) };

  // 2) Воронка: открытые сделки с плановой покупкой в месяце.
  const pipe = await pool.query(
    `SELECT deal_id, company_name, stage_id, likely_deal, (${kzt}) AS v FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND planned_purchase_date BETWEEN $2 AND $3`, [PRECONTRACT, per.from, per.to]);
  const deals = pipe.rows.map(r => {
    const v = parseFloat(r.v) || 0; const step = stepOf(r.stage_id);
    let p = STEP_PROB[step] || 0.2; if (r.likely_deal) p = Math.max(p, 0.75);
    return { id: r.deal_id, company: r.company_name || '', step, likely: !!r.likely_deal, v, p, signal: null };
  });

  // 3) Комментарии → корректировка вероятности (топ по сумме среди P60/P80/наиболее вероятных).
  const cand = deals.filter(d => d.p >= 0.5).sort((a, b) => b.v - a.v).slice(0, 30);
  let scanned = 0;
  try {
    await mapLimit(cand, 6, async (d) => {
      const sig = await commentSignal(d.id); scanned++;
      d.signal = sig.signal; d.snippet = sig.snippet || '';
      if (sig.signal === 'near') d.p = Math.max(d.p, 0.92);
      else if (sig.signal === 'stall') d.p = Math.min(d.p, 0.15);
    });
  } catch (_) {}

  // Взвешенная сумма и разброс (нормальное приближение).
  let weighted = 0, variance = 0, faceSum = 0;
  const buck = { P80: { s: 0, c: 0 }, P60: { s: 0, c: 0 }, early: { s: 0, c: 0 }, likely: { s: 0, c: 0 } };
  for (const d of deals) {
    weighted += d.v * d.p; variance += d.p * (1 - d.p) * d.v * d.v; faceSum += d.v;
    if (d.likely) { buck.likely.s += d.v; buck.likely.c++; }
    if (d.step === 'P80') { buck.P80.s += d.v; buck.P80.c++; }
    else if (d.step === 'P60') { buck.P60.s += d.v; buck.P60.c++; }
    else { buck.early.s += d.v; buck.early.c++; }
  }
  for (const k of Object.keys(buck)) buck[k].s = Math.round(buck[k].s);
  const sd = Math.sqrt(variance);
  const p50 = actual.sum + Math.round(weighted);
  const p10 = actual.sum + Math.round(Math.max(0, weighted - 1.2816 * sd));
  const p90 = actual.sum + Math.round(weighted + 1.2816 * sd);

  // Список «на подписании» (по комментариям), топ по сумме.
  const signing = deals.filter(d => d.signal === 'near').sort((a, b) => b.v - a.v).slice(0, 8)
    .map(d => ({ company: d.company, sum: Math.round(d.v), snippet: d.snippet || '' }));
  const stalled = deals.filter(d => d.signal === 'stall').length;

  // Дополнительно: P80/наиболее вероятные без даты плановой покупки (потенциал, в оценку не входит).
  const nod = await pool.query(
    `SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals
     WHERE (stage_id = ANY($1) OR likely_deal = true) AND planned_purchase_date IS NULL
       AND stage_id = ANY($2)`, [P80_SET, PRECONTRACT]);
  const noDate = { sum: num(nod.rows[0].s), count: parseInt(nod.rows[0].c, 10) };

  // 5a) Темп с начала года.
  const rr = await pool.query(`SELECT COALESCE(SUM(${kzt}),0) s, COUNT(DISTINCT date_trunc('month', contract_date)) m FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date >= $2 AND contract_date < $3`, [CONTRACT_SET, `${per.year}-01-01`, per.from]);
  const rrMonths = parseInt(rr.rows[0].m, 10) || 0;
  const runRate = rrMonths ? Math.round(num(rr.rows[0].s) / rrMonths) : 0;

  // 5b) Тот же месяц год назад.
  const ly = await pool.query(`SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`, [CONTRACT_SET, shiftYear(per.from, -1), shiftYear(per.to, -1)]);
  const lastYear = { sum: num(ly.rows[0].s), count: parseInt(ly.rows[0].c, 10) };

  // 5c) Коэффициент сбычи планов: из плановых покупок прошлых месяцев — сколько подписалось (по деньгам).
  let plannedHitRate = null;
  try {
    const ph = await pool.query(
      `SELECT COALESCE(SUM(${kzt}) FILTER (WHERE stage_id = ANY($1)),0) signed, COALESCE(SUM(${kzt}),0) planned
       FROM ticketsmodule_stat_deals WHERE planned_purchase_date >= $2 AND planned_purchase_date < $3`,
      [CONTRACT_SET, `${per.year}-01-01`, per.from]);
    const s = parseFloat(ph.rows[0].signed) || 0, pl = parseFloat(ph.rows[0].planned) || 0;
    if (pl > 0) plannedHitRate = Math.round((s / pl) * 100);
  } catch (_) {}

  // 6) Снимок воронки на сегодня (копится для истории).
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_plsai_pipeline_snap (taken_on, month, actual_sum, weighted, p60_sum, p80_sum, likely_sum, planned_face)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (taken_on, month) DO UPDATE SET actual_sum=$2, weighted=$3, p60_sum=$4, p80_sum=$5, likely_sum=$6, planned_face=$7`,
      [`${per.year}-${String(per.month).padStart(2, '0')}`, actual.sum, Math.round(weighted), buck.P60.s, buck.P80.s, buck.likely.s, Math.round(faceSum)]);
  } catch (_) {}

  return {
    forecast: true, period: per,
    estimate: { point: p50, low: p10, high: p90 },
    actual, weighted: Math.round(weighted), pipeline: buck, faceSum: Math.round(faceSum),
    comments: { scanned, signing, stalled },
    noDate, refs: { runRate, lastYear, plannedHitRate },
    hasPlanned: deals.length > 0,
  };
}

module.exports = { looksLikeForecast, runForecast };

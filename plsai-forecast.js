// ProLab AI — прогноз продаж на месяц (v3, «честный»).
// Ведём прогноз ОТ ФАКТА и ТЕМПА (pacing по рабочим дням), а не от полной воронки.
// Слои: (1) уже подписано; (2) pacing — историческая доля месяца к этому раб. дню →
// итог ≈ факт / доля; (3) воронка учитывается только как остаток, реально закрываемый
// за оставшиеся дни (+ известные «на подписании» из комментариев); (4) воронка целиком
// показывается отдельно как «теоретический потолок» и «уедет на след. месяц»;
// (5) ориентиры: темп с начала года, тот же месяц год назад, сбыча планов в срок;
// (6) ежедневный снимок воронки (копится для истории).
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { STEP_STAGES, PRECONTRACT, CONTRACT_SET } = require('./plsai-calc');
const { empiricalStageProbs, salesTrend } = require('./plsai-wave2');

const STEP_PROB = { P10: 0.10, P30: 0.30, P60: 0.60, P80: 0.80 };
const P80_SET = STEP_STAGES.P80;
const MONTHS = { 'январ': 1, 'феврал': 2, 'март': 3, 'марте': 3, 'апрел': 4, 'мае': 5, 'май': 5, 'июн': 6, 'июл': 7, 'август': 8, 'авгус': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12 };
const MON_NAME = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

// «Застряло» проверяем ПЕРВЫМ (приоритет): согласование/ожидание/перенос — это НЕ близко к подписи.
const STALL_RE = /в ожидани|ожида[ею]м реш|пока\b|перенес|отлож|заморож|нет бюджет|бюджет не|проигра|отказ|отмен|сорвал|заглох|не выход[а-яё]* на связ|тишина|приостанов|на согласовани|на рассмотрени|думают|не готов|не подтверд/;
// «На подписании» — только явные сигналы скорой подписи/оплаты.
const NEAR_RE = /на подписани|отправил[а-яё]* на подпис|жд[ёе]м подписани|готов[а-яё]* к подписани|подписыва[а-яё]* договор|подписал[а-яё]* договор|подписание договор|сч[ёе]т на подпис|оплата получ|оплат[а-яё]* поступ|тендер выигра|выигра[а-яё]* тендер/;

function astanaNow() { return new Date(Date.now() + 5 * 3600000); }
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }
function shiftYear(s, delta) { const p = String(s).split('-'); return (parseInt(p[0], 10) + delta) + '-' + p[1] + '-' + p[2]; }
function stepOf(id) { for (const s of ['P80', 'P60', 'P30', 'P10']) if ((STEP_STAGES[s] || []).includes(id)) return s; return null; }
// Индекс рабочего дня (Пн–Пт) внутри месяца для числа d.
function wdIndex(y, m, d) { let n = 0; for (let i = 1; i <= d; i++) { const w = new Date(y, m - 1, i).getDay(); if (w !== 0 && w !== 6) n++; } return n; }
function wdTotal(y, m) { return wdIndex(y, m, lastDay(y, m)); }

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
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_plsai_comment_signal (deal_id INTEGER PRIMARY KEY, signal VARCHAR(12), snippet TEXT, checked_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_plsai_pipeline_snap (taken_on DATE, month VARCHAR(7), actual_sum BIGINT, weighted BIGINT, p60_sum BIGINT, p80_sum BIGINT, likely_sum BIGINT, planned_face BIGINT, PRIMARY KEY (taken_on, month))`);
  _tablesReady = true;
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (_) { out[idx] = null; } }
  });
  await Promise.all(workers); return out;
}

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
    if (STALL_RE.test(joined)) { signal = 'stall'; snippet = (texts.find(t => STALL_RE.test(t.toLowerCase())) || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
    else if (NEAR_RE.test(joined)) { signal = 'near'; snippet = (texts.find(t => NEAR_RE.test(t.toLowerCase())) || '').replace(/\s+/g, ' ').trim().slice(0, 160); }
  } catch (_) { signal = 'neutral'; }
  try { await pool.query(`INSERT INTO ticketsmodule_plsai_comment_signal (deal_id,signal,snippet,checked_at) VALUES ($1,$2,$3,NOW()) ON CONFLICT (deal_id) DO UPDATE SET signal=$2,snippet=$3,checked_at=NOW()`, [dealId, signal, snippet]); } catch (_) {}
  return { signal, snippet };
}

// Историческая доля месяца, набираемая к рабочему дню elapsedWD (pacing-кривая).
async function pacingFraction(per, elapsedWD, kzt) {
  if (elapsedWD <= 0) return { frac: null, months: 0 };
  const start = shiftYear(per.from, -1);   // окно ~ год назад до начала целевого месяца
  const { rows } = await pool.query(
    `SELECT to_char(contract_date,'YYYY-MM') ym, EXTRACT(YEAR FROM contract_date)::int y, EXTRACT(MONTH FROM contract_date)::int m,
            EXTRACT(DAY FROM contract_date)::int d, (${kzt}) v
     FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date >= $2 AND contract_date < $3`,
    [CONTRACT_SET, start, per.from]);
  const byM = {};
  for (const r of rows) {
    const k = r.ym; if (!byM[k]) byM[k] = { total: 0, cum: 0, y: r.y, m: r.m };
    const v = parseFloat(r.v) || 0; byM[k].total += v;
    if (wdIndex(r.y, r.m, r.d) <= elapsedWD) byM[k].cum += v;
  }
  const fracs = Object.values(byM).filter(x => x.total > 0).map(x => x.cum / x.total);
  if (!fracs.length) return { frac: null, months: 0 };
  const avg = fracs.reduce((s, x) => s + x, 0) / fracs.length;
  return { frac: Math.min(0.99, Math.max(0.05, avg)), months: fracs.length };
}

async function runForecast(qRaw) {
  const rate = await getTodayRate();
  const per = detectForecastMonth(qRaw);
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const num = v => Math.round(parseFloat(v) || 0);
  try { await ensureTables(); } catch (_) {}

  const now = astanaNow();
  const totalWD = wdTotal(per.year, per.month);
  const isCurrent = (now.getFullYear() === per.year && now.getMonth() + 1 === per.month);
  const isPast = (per.year < now.getFullYear()) || (per.year === now.getFullYear() && per.month < now.getMonth() + 1);
  const elapsedWD = isPast ? totalWD : (isCurrent ? wdIndex(per.year, per.month, now.getDate()) : 0);
  const remainingWD = Math.max(0, totalWD - elapsedWD);

  // 1) Уже подписано в месяце.
  const act = await pool.query(`SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`, [CONTRACT_SET, per.from, per.to]);
  const actual = { sum: num(act.rows[0].s), count: parseInt(act.rows[0].c, 10) };

  // 2) Воронка (открытые, план покупки в месяце) + комментарии.
  const pipe = await pool.query(
    `SELECT deal_id, company_name, stage_id, department_id, likely_deal, (${kzt}) AS v,
            (CURRENT_DATE - date_create) AS age FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND planned_purchase_date BETWEEN $2 AND $3`, [PRECONTRACT, per.from, per.to]);
  let emp = { probs: {}, source: 'fallback' };
  try { emp = await empiricalStageProbs(); } catch (_) {}
  const deals = pipe.rows.map(r => {
    const v = parseFloat(r.v) || 0; const step = stepOf(r.stage_id);
    let p = (emp.probs && emp.probs[step]) || STEP_PROB[step] || 0.2; if (r.likely_deal) p = Math.max(p, 0.75);
    return { id: r.deal_id, company: r.company_name || '', dept: r.department_id, step, likely: !!r.likely_deal, v, p, age: r.age == null ? null : parseInt(r.age, 10), signal: null, snippet: '' };
  });
  // Типичная длина цикла (для риск-флагов проскальзывания).
  let typCycle = 60;
  try {
    const cy = await pool.query(`SELECT AVG(EXTRACT(EPOCH FROM (contract_date - date_create))/86400) c FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND date_create IS NOT NULL AND contract_date IS NOT NULL AND contract_date >= $2`, [CONTRACT_SET, shiftYear(per.from, -1)]);
    if (cy.rows[0].c) typCycle = Math.max(20, Math.round(parseFloat(cy.rows[0].c)));
  } catch (_) {}
  const cand = deals.filter(d => d.p >= 0.5).sort((a, b) => b.v - a.v).slice(0, 30);
  let scanned = 0;
  try {
    await mapLimit(cand, 6, async (d) => {
      const sig = await commentSignal(d.id); scanned++;
      d.signal = sig.signal; d.snippet = sig.snippet || '';
      if (sig.signal === 'near') d.p = Math.max(d.p, 0.9);
      else if (sig.signal === 'stall') d.p = Math.min(d.p, 0.1);
    });
  } catch (_) {}

  let weighted = 0, faceSum = 0;
  const buck = { P80: { s: 0, c: 0 }, P60: { s: 0, c: 0 }, early: { s: 0, c: 0 }, likely: { s: 0, c: 0 } };
  const deptW = {};            // взвешенная воронка по отделам
  const slipRisk = { count: 0, sum: 0, items: [] };  // риск проскальзывания (висят дольше типичного цикла)
  for (const d of deals) {
    weighted += d.v * d.p; faceSum += d.v;
    if (d.likely) { buck.likely.s += d.v; buck.likely.c++; }
    if (d.step === 'P80') { buck.P80.s += d.v; buck.P80.c++; }
    else if (d.step === 'P60') { buck.P60.s += d.v; buck.P60.c++; }
    else { buck.early.s += d.v; buck.early.c++; }
    deptW[d.dept] = (deptW[d.dept] || 0) + d.v * d.p;
    if (d.age != null && d.age > typCycle * 1.3 && d.p >= 0.5) { slipRisk.count++; slipRisk.sum += d.v; slipRisk.items.push({ company: d.company, sum: Math.round(d.v), age: d.age }); }
  }
  for (const k of Object.keys(buck)) buck[k].s = Math.round(buck[k].s);
  weighted = Math.round(weighted);
  slipRisk.sum = Math.round(slipRisk.sum);
  slipRisk.items = slipRisk.items.sort((a, b) => b.sum - a.sum).slice(0, 5);

  // Известные «на подписании» — ожидаем реально закрыть скоро.
  const nearDeals = deals.filter(d => d.signal === 'near');
  const nearExpected = Math.round(nearDeals.reduce((s, d) => s + d.v * 0.8, 0));
  const signing = nearDeals.sort((a, b) => b.v - a.v).slice(0, 8).map(d => ({ company: d.company, sum: Math.round(d.v), snippet: d.snippet }));
  const stalled = deals.filter(d => d.signal === 'stall').length;

  // 2b) Pacing: историческая доля месяца к текущему раб. дню.
  const pace = await pacingFraction(per, elapsedWD, kzt);

  // 3) ЧЕСТНЫЙ остаток до конца месяца.
  let expectedRemaining, basis;
  if (isPast) { expectedRemaining = 0; basis = 'месяц завершён'; }
  else if (pace.frac && actual.sum > 0) {
    // Ожидаемый итог = факт / доля; остаток = итог − факт. Плюс не меньше известных «на подписании».
    const paceTotal = actual.sum / pace.frac;
    expectedRemaining = Math.max(0, Math.round(paceTotal - actual.sum), nearExpected);
    basis = `темп: обычно к этому дню закрыто ~${Math.round(pace.frac * 100)}%`;
  } else {
    // Нет надёжного темпа (начало месяца / нет истории) — остаток по воронке, ужатой на оставшееся время.
    const timeShare = totalWD ? Math.min(1, remainingWD / totalWD) : 0.3;
    expectedRemaining = Math.max(Math.round(weighted * 0.35 * timeShare), nearExpected);
    basis = 'оценка по воронке (нет истории темпа)';
  }
  // Остаток физически не больше того, что есть в воронке.
  expectedRemaining = Math.min(expectedRemaining, weighted + nearExpected);

  // Разрез по отделам: уже подписано + взвешенная воронка.
  const DEP_LBL = { '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия', '4860': 'Клеточный анализ', '4862': 'ОРМ', '4863': 'Сервис', '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение' };
  let deptBreak = [];
  try {
    const ds = await pool.query(`SELECT department_id d, COALESCE(SUM(${kzt}),0) s FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3 GROUP BY department_id`, [CONTRACT_SET, per.from, per.to]);
    const signedByDept = {}; ds.rows.forEach(r => { signedByDept[r.d] = Math.round(parseFloat(r.s) || 0); });
    const keys = new Set([...Object.keys(signedByDept), ...Object.keys(deptW)]);
    const SKIP = new Set(['null', '', '4866']);   // без отдела + Комплекс (зонтичные) в разрезе не показываем
    deptBreak = [...keys].filter(d => d != null && !SKIP.has(String(d))).map(d => ({ dept: DEP_LBL[d] || String(d), signed: signedByDept[d] || 0, pipeline: Math.round(deptW[d] || 0) }))
      .filter(x => x.signed > 0 || x.pipeline > 0).sort((a, b) => (b.signed + b.pipeline) - (a.signed + a.pipeline)).slice(0, 12);
  } catch (_) {}

  const point = actual.sum + expectedRemaining;
  const low = actual.sum + Math.round(Math.min(nearExpected, expectedRemaining));
  const high = actual.sum + Math.min(Math.round(expectedRemaining * 1.7 + nearExpected * 0.5), weighted);
  const ceiling = actual.sum + weighted;                 // теоретический потолок (если бы всё закрылось)
  const slip = Math.max(0, weighted - expectedRemaining); // вероятно уедет на след. месяц

  // Ориентиры.
  const rr = await pool.query(`SELECT COALESCE(SUM(${kzt}),0) s, COUNT(DISTINCT date_trunc('month', contract_date)) m FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date >= $2 AND contract_date < $3`, [CONTRACT_SET, `${per.year}-01-01`, per.from]);
  const rrMonths = parseInt(rr.rows[0].m, 10) || 0;
  const runRate = rrMonths ? Math.round(num(rr.rows[0].s) / rrMonths) : 0;
  const ly = await pool.query(`SELECT COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`, [CONTRACT_SET, shiftYear(per.from, -1), shiftYear(per.to, -1)]);
  const lastYear = { sum: num(ly.rows[0].s), count: parseInt(ly.rows[0].c, 10) };
  let onTimeRate = null;
  try {
    const ph = await pool.query(
      `SELECT COALESCE(SUM(${kzt}) FILTER (WHERE stage_id = ANY($1) AND contract_date <= (planned_purchase_date + INTERVAL '31 days')),0) ontime,
              COALESCE(SUM(${kzt}),0) planned
       FROM ticketsmodule_stat_deals WHERE planned_purchase_date >= $2 AND planned_purchase_date < $3`,
      [CONTRACT_SET, `${per.year}-01-01`, per.from]);
    const o = parseFloat(ph.rows[0].ontime) || 0, pl = parseFloat(ph.rows[0].planned) || 0;
    if (pl > 0) onTimeRate = Math.round((o / pl) * 100);
  } catch (_) {}

  try {
    await pool.query(
      `INSERT INTO ticketsmodule_plsai_pipeline_snap (taken_on, month, actual_sum, weighted, p60_sum, p80_sum, likely_sum, planned_face)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (taken_on, month) DO UPDATE SET actual_sum=$2, weighted=$3, p60_sum=$4, p80_sum=$5, likely_sum=$6, planned_face=$7`,
      [`${per.year}-${String(per.month).padStart(2, '0')}`, actual.sum, weighted, buck.P60.s, buck.P80.s, buck.likely.s, Math.round(faceSum)]);
  } catch (_) {}

  // Holt-Winters: тренд+сезонность (независимый top-down ориентир на след. месяц).
  let hw = null; try { hw = await salesTrend(); } catch (_) {}

  // Pacing-вердикт: идём ли мы в графике (факт vs типичный уровень к этому дню).
  let pacing = null;
  if (!isPast && pace.frac && runRate > 0) {
    const expectedByNow = Math.round(runRate * pace.frac);
    const pct = expectedByNow > 0 ? Math.round((actual.sum / expectedByNow - 1) * 100) : 0;
    pacing = { expectedByNow, pct, verdict: pct >= 8 ? 'ahead' : (pct <= -8 ? 'behind' : 'ontrack') };
  }

  return {
    forecast: true, period: per,
    days: { total: totalWD, elapsed: elapsedWD, remaining: remainingWD },
    estimate: { point, low, high }, expectedRemaining, basis,
    actual, weighted, pipeline: buck, ceiling, slip, pacing, slipRisk, deptBreak, typCycle,
    comments: { scanned, signing, stalled },
    refs: { runRate, lastYear, onTimeRate, pacePct: pace.frac ? Math.round(pace.frac * 100) : null, paceMonths: pace.months,
            empiricalSource: emp.source, empiricalProbs: emp.probs, hwNext: hw && hw.nextMonth, hwSeasonPct: hw && hw.seasonalPct, hwMonths: hw && hw.months },
    hasPlanned: deals.length > 0,
  };
}

module.exports = { looksLikeForecast, runForecast };

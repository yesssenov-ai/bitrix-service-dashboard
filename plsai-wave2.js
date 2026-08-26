// ProLab AI — Волна 2: эмпирические вероятности стадий, Holt-Winters (тренд+сезонность),
// когортный анализ дозревания. Всё в Postgres/JS, токенов не тратит.
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { STEP_STAGES, CONTRACT_SET } = require('./plsai-calc');

const NOMINAL = { P10: 0.10, P30: 0.30, P60: 0.60, P80: 0.80 };
function stepOf(id) { for (const s of ['P80', 'P60', 'P30', 'P10']) if ((STEP_STAGES[s] || []).includes(id)) return s; return null; }
const CONTRACT_SETX = new Set(CONTRACT_SET);

// ── (2) Эмпирические вероятности: доля дошедших до подписания среди дошедших до стадии ──
let _emp = null, _empAt = 0;
async function empiricalStageProbs() {
  if (_emp && Date.now() - _empAt < 6 * 3600000) return _emp;
  const out = { probs: Object.assign({}, NOMINAL), samples: {}, source: 'fallback' };
  try {
    const { rows } = await pool.query('SELECT deal_id, stage_id FROM ticketsmodule_stage_history');
    if (rows.length) {
      const byDeal = {};
      for (const r of rows) { const d = (byDeal[r.deal_id] = byDeal[r.deal_id] || { steps: new Set(), won: false }); const st = stepOf(r.stage_id); if (st) d.steps.add(st); if (CONTRACT_SETX.has(r.stage_id)) d.won = true; }
      const cnt = { P10: [0, 0], P30: [0, 0], P60: [0, 0], P80: [0, 0] };  // [reached, reached&won]
      for (const id in byDeal) { const d = byDeal[id]; for (const s of ['P10', 'P30', 'P60', 'P80']) if (d.steps.has(s)) { cnt[s][0]++; if (d.won) cnt[s][1]++; } }
      let any = false;
      for (const s of ['P10', 'P30', 'P60', 'P80']) {
        out.samples[s] = cnt[s][0];
        if (cnt[s][0] >= 20) { out.probs[s] = Math.min(0.98, Math.max(0.02, cnt[s][1] / cnt[s][0])); any = true; }
      }
      if (any) out.source = 'history';
    }
  } catch (_) {}
  _emp = out; _empAt = Date.now();
  return out;
}

// ── (6) Holt-Winters (аддитивный, сезон 12). Прогноз следующего месяца по ряду подписаний ──
function holtWinters(series, period, alpha, beta, gamma) {
  const n = series.length;
  if (n < period + 2) {
    // мало данных для сезонности — двойное сглаживание (тренд без сезона)
    let level = series[0], trend = series[1] - series[0];
    for (let i = 1; i < n; i++) { const l = alpha * series[i] + (1 - alpha) * (level + trend); trend = beta * (l - level) + (1 - beta) * trend; level = l; }
    return { next: Math.max(0, Math.round(level + trend)), haveSeason: false, seasonal: null };
  }
  const seasons = Math.floor(n / period);
  let level = 0, trend = 0; const seasonal = new Array(period).fill(0);
  const first = series.slice(0, period);
  level = first.reduce((a, b) => a + b, 0) / period;
  // тренд — средняя разница между первыми двумя сезонами
  for (let i = 0; i < period; i++) trend += (series[period + i] - series[i]) / period;
  trend /= period;
  for (let i = 0; i < period; i++) seasonal[i] = series[i] - level;
  for (let i = 0; i < n; i++) {
    const s = seasonal[i % period];
    const l = alpha * (series[i] - s) + (1 - alpha) * (level + trend);
    trend = beta * (l - level) + (1 - beta) * trend;
    seasonal[i % period] = gamma * (series[i] - l) + (1 - gamma) * s;
    level = l;
  }
  const next = level + trend + seasonal[n % period];
  return { next: Math.max(0, Math.round(next)), haveSeason: true, seasonal };
}

let _hw = null, _hwAt = 0;
async function salesTrend() {
  if (_hw && Date.now() - _hwAt < 6 * 3600000) return _hw;
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const out = { series: [], nextMonth: null, haveSeason: false, months: 0, seasonalPct: null };
  try {
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month',contract_date),'YYYY-MM') ym, SUM(${kzt}) s
       FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date IS NOT NULL
       AND contract_date < date_trunc('month', CURRENT_DATE)
       GROUP BY 1 ORDER BY 1`, [CONTRACT_SET]);
    if (rows.length >= 6) {
      // непрерывный ряд от первого до последнего месяца
      const map = {}; rows.forEach(r => { map[r.ym] = Math.round(parseFloat(r.s) || 0); });
      const [fy, fm] = rows[0].ym.split('-').map(Number);
      const [ly, lm] = rows[rows.length - 1].ym.split('-').map(Number);
      const series = []; const labels = [];
      let y = fy, m = fm;
      while (y < ly || (y === ly && m <= lm)) { const k = `${y}-${String(m).padStart(2, '0')}`; series.push(map[k] || 0); labels.push(k); m++; if (m > 12) { m = 1; y++; } }
      const hw = holtWinters(series, 12, 0.4, 0.1, 0.3);
      out.series = series.slice(-12); out.nextMonth = hw.next; out.haveSeason = hw.haveSeason; out.months = series.length;
      if (hw.haveSeason && hw.seasonal) {
        // сезонный фактор следующего месяца vs средний уровень
        const avgAbs = series.slice(-12).reduce((a, b) => a + Math.abs(b), 0) / 12 || 1;
        out.seasonalPct = Math.round((hw.seasonal[series.length % 12] / avgAbs) * 100);
      }
    }
  } catch (_) {}
  _hw = out; _hwAt = Date.now();
  return out;
}

// ── (7) Когортное дозревание: сделки по месяцу создания — сколько уже подписано ──
async function cohortMaturation() {
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const out = { rows: [] };
  try {
    const { rows } = await pool.query(
      `SELECT to_char(date_trunc('month',date_create),'YYYY-MM') ym,
              COUNT(*) total, COUNT(*) FILTER (WHERE stage_id = ANY($1)) won,
              COALESCE(SUM(${kzt}),0) total_s, COALESCE(SUM(${kzt}) FILTER (WHERE stage_id = ANY($1)),0) won_s,
              AVG(EXTRACT(EPOCH FROM (contract_date - date_create))/86400) FILTER (WHERE stage_id = ANY($1) AND contract_date IS NOT NULL) days
       FROM ticketsmodule_stat_deals WHERE date_create IS NOT NULL AND date_create >= (CURRENT_DATE - INTERVAL '13 months')
       GROUP BY 1 ORDER BY 1 DESC LIMIT 12`, [CONTRACT_SET]);
    out.rows = rows.map(r => ({
      month: r.ym, total: parseInt(r.total, 10), won: parseInt(r.won, 10),
      wonRate: parseInt(r.total, 10) ? Math.round(parseInt(r.won, 10) / parseInt(r.total, 10) * 100) : 0,
      wonSum: Math.round(parseFloat(r.won_s) || 0), totalSum: Math.round(parseFloat(r.total_s) || 0),
      days: r.days ? Math.round(parseFloat(r.days)) : null,
    }));
  } catch (_) {}
  return out;
}

module.exports = { empiricalStageProbs, salesTrend, cohortMaturation };

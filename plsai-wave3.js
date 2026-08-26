// ProLab AI — Волна 3: (8) ансамбль методов с бэктестом точности; (9) ML-скоринг сделок
// (логистическая регрессия). Всё в Node/Postgres, токенов не тратит.
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { PRECONTRACT, CONTRACT_SET } = require('./plsai-calc');
const { holtWinters } = require('./plsai-wave2');
const { LOST_SET, DEPARTMENT_LABELS } = require('./plsai-analytics');
const { USERS } = require('./constants');

const kztExpr = rate => `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
const CONTRACT_SETX = new Set(CONTRACT_SET);
const LOST_SETX = new Set(LOST_SET);

// Непрерывный помесячный ряд подписаний (полные месяцы).
async function monthlySeries(rate) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month',contract_date),'YYYY-MM') ym, SUM(${kztExpr(rate)}) s
     FROM ticketsmodule_stat_deals WHERE stage_id = ANY($1) AND contract_date IS NOT NULL
       AND contract_date < date_trunc('month', CURRENT_DATE) GROUP BY 1 ORDER BY 1`, [CONTRACT_SET]);
  if (rows.length < 4) return { series: [], labels: [] };
  const map = {}; rows.forEach(r => { map[r.ym] = Math.round(parseFloat(r.s) || 0); });
  const [fy, fm] = rows[0].ym.split('-').map(Number);
  const [ly, lm] = rows[rows.length - 1].ym.split('-').map(Number);
  const series = [], labels = []; let y = fy, m = fm;
  while (y < ly || (y === ly && m <= lm)) { const k = `${y}-${String(m).padStart(2, '0')}`; series.push(map[k] || 0); labels.push(k); m++; if (m > 12) { m = 1; y++; } }
  return { series, labels };
}

// (8) Бэктест методов и взвешенный ансамбль.
let _ens = null, _ensAt = 0;
async function ensembleBacktest() {
  if (_ens && Date.now() - _ensAt < 6 * 3600000) return _ens;
  const rate = await getTodayRate();
  const out = { methods: [], blended: null, backtestMonths: 0 };
  try {
    const { series } = await monthlySeries(rate);
    const n = series.length;
    if (n >= 8) {
      const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
      const methods = {
        'Средний темп (3м)': (s, i) => i >= 3 ? mean(s.slice(i - 3, i)) : null,
        'Сезонный (год назад)': (s, i) => i >= 12 ? s[i - 12] : (i >= 1 ? mean(s.slice(0, i)) : null),
        'Holt-Winters': (s, i) => { if (i < 4) return null; const hw = holtWinters(s.slice(0, i), 12, 0.4, 0.1, 0.3); return hw.next; },
      };
      const K = Math.min(6, n - 4);   // сколько последних месяцев проверяем
      const res = {};
      for (const name in methods) res[name] = { errs: [], biases: [] };
      for (let i = n - K; i < n; i++) {
        const actual = series[i]; if (actual <= 0) continue;
        for (const name in methods) {
          const pred = methods[name](series, i);
          if (pred == null || !isFinite(pred)) continue;
          res[name].errs.push(Math.abs(pred - actual) / actual);
          res[name].biases.push((pred - actual) / actual);
        }
      }
      const rows = [];
      for (const name in methods) {
        const e = res[name].errs; if (!e.length) continue;
        const mape = Math.round(mean(e) * 100);
        const bias = Math.round(mean(res[name].biases) * 100);
        const next = methods[name](series, n); // прогноз на следующий месяц (на всей истории)
        rows.push({ name, mape, bias, next: next != null && isFinite(next) ? Math.round(next) : null });
      }
      const valid = rows.filter(r => r.next != null && r.mape != null);
      if (valid.length) {
        let wsum = 0; valid.forEach(r => { r.w = 1 / Math.max(3, r.mape); wsum += r.w; });
        valid.forEach(r => { r.weight = Math.round(r.w / wsum * 100); });
        const blended = Math.round(valid.reduce((s, r) => s + r.w * r.next, 0) / wsum);
        out.methods = valid.map(r => ({ name: r.name, mape: r.mape, bias: r.bias, weight: r.weight, next: r.next }));
        out.blended = blended;
        out.backtestMonths = K;
      }
    }
  } catch (_) {}
  _ens = out; _ensAt = Date.now();
  return out;
}

// ── (9) ML-скоринг: логистическая регрессия на закрытых сделках ──
function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
let _ml = null, _mlAt = 0;
async function mlPropensity() {
  if (_ml && Date.now() - _mlAt < 6 * 3600000) return _ml;
  const rate = await getTodayRate();
  const out = { trained: false };
  try {
    const kzt = kztExpr(rate);
    const { rows } = await pool.query(
      `SELECT deal_id, company_name, stage_id, department_id, manufacturer, likely_deal, assigned_by_id,
              (${kzt}) v, (CURRENT_DATE - date_create) age
       FROM ticketsmodule_stat_deals
       WHERE stage_id = ANY($1) OR stage_id = ANY($2) OR stage_id = ANY($3)`,
      [CONTRACT_SET, LOST_SET, PRECONTRACT]);
    // Топ-отделы и топ-производители для one-hot.
    const depCount = {}, mfrCount = {};
    rows.forEach(r => { if (r.department_id) depCount[r.department_id] = (depCount[r.department_id] || 0) + 1; const mf = (r.manufacturer || '').trim(); if (mf) mfrCount[mf] = (mfrCount[mf] || 0) + 1; });
    const topDeps = Object.entries(depCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
    const topMfr = Object.entries(mfrCount).sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]);
    // Признаки.
    const feat = (r) => {
      const f = [1]; // bias
      f.push(Math.log((parseFloat(r.v) || 0) + 1));          // ln(сумма)
      f.push(r.likely_deal ? 1 : 0);
      f.push(Math.min(1, (parseInt(r.age, 10) || 0) / 365)); // возраст (норм.)
      topDeps.forEach(d => f.push(String(r.department_id) === String(d) ? 1 : 0));
      topMfr.forEach(m => f.push((r.manufacturer || '').trim() === m ? 1 : 0));
      return f;
    };
    // Обучающая выборка = закрытые (won=1 / lost=0).
    const train = [];
    for (const r of rows) {
      if (CONTRACT_SETX.has(r.stage_id)) train.push({ x: feat(r), y: 1 });
      else if (LOST_SETX.has(r.stage_id)) train.push({ x: feat(r), y: 0 });
    }
    if (train.length < 60) { out.reason = 'мало закрытых сделок для обучения (' + train.length + ')'; _ml = out; _mlAt = Date.now(); return out; }
    // Нормировка ln(сумма) (индекс 1).
    const col1 = train.map(t => t.x[1]); const mu = col1.reduce((a, b) => a + b, 0) / col1.length;
    const sd = Math.sqrt(col1.reduce((a, b) => a + (b - mu) * (b - mu), 0) / col1.length) || 1;
    const norm = x => { const z = x.slice(); z[1] = (z[1] - mu) / sd; return z; };
    const dim = train[0].x.length;
    let w = new Array(dim).fill(0);
    const lr = 0.1, lambda = 0.001, iters = 400;
    for (let it = 0; it < iters; it++) {
      const grad = new Array(dim).fill(0);
      for (const t of train) {
        const z = norm(t.x); let s = 0; for (let j = 0; j < dim; j++) s += w[j] * z[j];
        const err = sigmoid(s) - t.y;
        for (let j = 0; j < dim; j++) grad[j] += err * z[j];
      }
      for (let j = 0; j < dim; j++) w[j] -= lr * (grad[j] / train.length + (j ? lambda * w[j] : 0));
    }
    // Точность на обучении (грубая) + скоринг открытых сделок.
    let correct = 0; for (const t of train) { const z = norm(t.x); let s = 0; for (let j = 0; j < dim; j++) s += w[j] * z[j]; if ((sigmoid(s) >= 0.5 ? 1 : 0) === t.y) correct++; }
    const open = rows.filter(r => PRECONTRACT.includes(r.stage_id)).map(r => {
      const z = norm(feat(r)); let s = 0; for (let j = 0; j < dim; j++) s += w[j] * z[j];
      return { company: r.company_name || '', manager: USERS[r.assigned_by_id] || '', prob: Math.round(sigmoid(s) * 100), sum: Math.round(parseFloat(r.v) || 0) };
    });
    const expectedByML = Math.round(open.reduce((s, d) => s + d.sum * d.prob / 100, 0));
    open.sort((a, b) => b.prob - a.prob);
    out.trained = true; out.trainN = train.length; out.accuracy = Math.round(correct / train.length * 100);
    out.expectedByML = expectedByML; out.openCount = open.length;
    out.top = open.slice(0, 8); out.bottom = open.slice(-6).reverse();
  } catch (e) { out.reason = e.message; }
  _ml = out; _mlAt = Date.now();
  return out;
}

module.exports = { ensembleBacktest, mlPropensity };

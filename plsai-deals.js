// ProLab AI — (4) сделки с неактуальными комментариями; (5) оценка вероятности сделки.
const XLSX = require('xlsx');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { STEP_STAGES, PRECONTRACT } = require('./plsai-calc');
const { USERS } = require('./constants');
const { commentMeta, mapLimit } = require('./plsai-comments');

const STEP_PROB = { P10: 0.10, P30: 0.30, P60: 0.60, P80: 0.80 };
const MONTHS = { 'январ': 1, 'феврал': 2, 'март': 3, 'марте': 3, 'апрел': 4, 'мае': 5, 'май': 5, 'июн': 6, 'июл': 7, 'август': 8, 'авгус': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12 };
const MON_NAME = ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
function stepOf(id) { for (const s of ['P80', 'P60', 'P30', 'P10']) if ((STEP_STAGES[s] || []).includes(id)) return s; return null; }
function astanaNow() { return new Date(Date.now() + 5 * 3600000); }
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }

function detectMonth(qRaw) {
  const now = astanaNow(); const curY = now.getFullYear();
  const ql = String(qRaw || '').toLowerCase();
  let year = null; const ym = ql.match(/20\d\d/); if (ym) year = +ym[0]; else if (/прошл[а-яё]*\s*год/.test(ql)) year = curY - 1;
  let month = null; for (const [k, v] of Object.entries(MONTHS)) { if (ql.includes(k)) { month = v; break; } }
  if (/следующ[а-яё]*\s*месяц|будущ[а-яё]*\s*месяц/.test(ql)) { const d = new Date(curY, now.getMonth() + 1, 1); month = d.getMonth() + 1; year = year || d.getFullYear(); }
  if (/через\s*2\s*месяц|через\s*два\s*месяц/.test(ql)) { const d = new Date(curY, now.getMonth() + 2, 1); month = d.getMonth() + 1; year = year || d.getFullYear(); }
  if (!month) month = now.getMonth() + 1;
  const y = year || curY;
  return { year: y, month, from: ymd(y, month, 1), to: ymd(y, month, lastDay(y, month)), label: `${MON_NAME[month]} ${y}` };
}
// Порог «устарело» растёт с удалённостью месяца: текущий →14 дн; +1/+2 →30 дн; дальше +30 за шаг.
function thresholdDays(dist) { if (dist <= 0) return 14; if (dist <= 2) return 30; return (dist - 1) * 30; }

function looksLikeStale(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /неактуальн[а-яё]* коммент|устаревш[а-яё]* коммент|устарел[а-яё]* коммент|давно не (обновл|коммент)|не обновля[а-яё]*.{0,20}коммент|коммент[а-яё]*.{0,20}не обновля|без свеж[а-яё]* коммент|заброшенн[а-яё]* сделк/.test(q);
}
function looksLikeProbability(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /вероятност[ья] сделк|шанс[ы]? сделк|оцен[иь][а-яё]* сделк|насколько вероятн|наиболее вероятн[а-яё]* сделк|вероятность что|вероятност[ья].{0,20}(сдел|подпиш|закро)|какие сделки (точно|скорее)/.test(q);
}

async function runStale(qRaw) {
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const per = detectMonth(qRaw);
  const now = astanaNow();
  const dist = (per.year - now.getFullYear()) * 12 + (per.month - (now.getMonth() + 1));
  const thr = thresholdDays(dist);
  const { rows } = await pool.query(
    `SELECT deal_id, company_name, assigned_by_id, stage_id, (${kzt}) v FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND planned_purchase_date BETWEEN $2 AND $3 ORDER BY (${kzt}) DESC LIMIT 80`,
    [PRECONTRACT, per.from, per.to]);
  const nowMs = Date.now();
  await mapLimit(rows, 6, async (r) => { const m = await commentMeta(r.deal_id); r._last = m.lastAt; r._sig = m.signal; });
  const items = rows.map(r => {
    const lastMs = r._last ? new Date(r._last).getTime() : null;
    const days = lastMs ? Math.floor((nowMs - lastMs) / 86400000) : null;
    const stale = (lastMs == null) || (days > thr);
    return { dealId: r.deal_id, company: r.company_name || '', manager: USERS[r.assigned_by_id] || '', managerId: r.assigned_by_id,
      sumKzt: Math.round(parseFloat(r.v) || 0), stage: stepOf(r.stage_id) || r.stage_id, lastAt: r._last ? new Date(r._last).toISOString().slice(0, 10) : null, days, stale };
  }).filter(x => x.stale).sort((a, b) => b.sumKzt - a.sumKzt);
  return { stale: true, period: per, thresholdDays: thr, dist, count: items.length, sumKzt: items.reduce((s, x) => s + x.sumKzt, 0), rows: items };
}
function buildStaleXlsx(res) {
  const header = ['Компания', 'Менеджер', 'Стадия', 'Сумма (₸)', 'Последний коммент', 'Дней без обновления', 'ID'];
  const aoa = [header, ...res.rows.map(x => [x.company, x.manager, x.stage, x.sumKzt, x.lastAt || 'нет', x.days == null ? '—' : x.days, x.dealId])];
  const ws = XLSX.utils.aoa_to_sheet(aoa); ws['!cols'] = [40, 22, 8, 16, 16, 14, 10].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Неактуальные'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// (5) Вероятность: стадия + флаг «наиболее вероятные» + смысл комментария.
async function runProbability(qRaw) {
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const per = detectMonth(qRaw);
  const { rows } = await pool.query(
    `SELECT deal_id, company_name, assigned_by_id, stage_id, likely_deal, (${kzt}) v FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND planned_purchase_date BETWEEN $2 AND $3 ORDER BY (${kzt}) DESC LIMIT 60`,
    [PRECONTRACT, per.from, per.to]);
  await mapLimit(rows, 6, async (r) => { const m = await commentMeta(r.deal_id); r._sig = m.signal; r._last = m.lastAt; r._snip = m.snippet; });
  const nowMs = Date.now();
  const items = rows.map(r => {
    const step = stepOf(r.stage_id); let p = STEP_PROB[step] || 0.2; const reasons = [step || '—'];
    if (r.likely_deal) { p = Math.max(p, 0.75); reasons.push('флаг «вероятная»'); }
    const days = r._last ? Math.floor((nowMs - new Date(r._last).getTime()) / 86400000) : null;
    const fresh = days != null && days <= 21;
    if (r._sig === 'near') { p = Math.max(p, 0.9); reasons.push('коммент: близко к подписанию'); }
    else if (r._sig === 'stall') { p = Math.min(p, 0.2); reasons.push('коммент: застряло'); }
    else if (days == null) { p = p * 0.85; reasons.push('нет комментариев'); }
    else if (!fresh) { p = p * 0.9; reasons.push(`коммент ${days} дн. назад`); }
    // «Наиболее вероятная» по правилу пользователя: (флаг ИЛИ near-коммент) И P60/P80 И свежий коммент.
    const hot = (r.likely_deal || r._sig === 'near') && (step === 'P60' || step === 'P80') && (r._sig === 'near' || fresh);
    return { dealId: r.deal_id, company: r.company_name || '', manager: USERS[r.assigned_by_id] || '', managerId: r.assigned_by_id,
      sumKzt: Math.round(parseFloat(r.v) || 0), stage: step || r.stage_id, prob: Math.round(Math.min(0.98, Math.max(0.02, p)) * 100), hot, reasons, snippet: r._snip || '' };
  }).sort((a, b) => b.prob - a.prob || b.sumKzt - a.sumKzt);
  const expected = Math.round(items.reduce((s, x) => s + x.sumKzt * x.prob / 100, 0));
  return { probability: true, period: per, count: items.length, expected, rows: items };
}

module.exports = { looksLikeStale, looksLikeProbability, runStale, runProbability, buildStaleXlsx };

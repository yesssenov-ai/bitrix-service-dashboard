// ProLab AI — аналитика Волны 1: win-rate по менеджерам/отделам и Sales Velocity.
// Всё считается в Postgres (токены не тратятся). Проигранные сделки в зеркале есть
// (синк тянет все стадии), поэтому конверсия честная.
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { PRECONTRACT, CONTRACT_SET } = require('./plsai-calc');
const { USERS } = require('./constants');

const LOST_SET = ['LOSE', 'C1:LOSE', 'C2:LOSE', 'C3:LOSE', 'APOLOGY', 'C1:APOLOGY', 'C2:APOLOGY', 'C3:APOLOGY'];
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия', '4860': 'Клеточный анализ',
  '4862': 'ОРМ', '4863': 'Сервис', '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const DEPT_ALIASES = {
  'элементн': ['4857'], 'хроматограф': ['4858'], 'электрохим': ['4859'], 'клеточн': ['4860'], 'орм': ['4862'],
  'сервис': ['4863'], 'тренинг': ['4864'], 'general lab': ['4865'], 'материаловед': ['8384'], 'комплекс': ['4866'],
};

function looksLikeWinrate(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /win-?rate|винрейт|конверси|конверт|дут[а-яё]* (пайплайн|воронк)|кто (лучше|хуже) закрыва|процент побед|доля побед/.test(q);
}
function looksLikeVelocity(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /velocity|скорость продаж|скорость выручк|sales velocity|скорость сделок/.test(q);
}

function astanaNow() { return new Date(Date.now() + 5 * 3600000); }
function detectPeriod(qRaw) {
  const now = astanaNow(); const y = now.getFullYear(); const ql = String(qRaw || '').toLowerCase();
  const ym = ql.match(/20\d\d/);
  if (ym) { const yy = +ym[0]; return { from: `${yy}-01-01`, to: `${yy}-12-31`, label: `за ${yy} год` }; }
  if (/прошл[а-яё]* год/.test(ql)) return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31`, label: `за ${y - 1} год` };
  if (/этот год|текущ[а-яё]* год|в этом году/.test(ql)) return { from: `${y}-01-01`, to: `${y}-12-31`, label: `за ${y} год` };
  // по умолчанию — последние 12 месяцев
  const d = new Date(now.getTime()); d.setFullYear(d.getFullYear() - 1);
  return { from: d.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), label: 'за последние 12 мес.' };
}
function detectGroup(qRaw) { return /по отдел|отдел[аоуы]|department/.test(String(qRaw || '').toLowerCase()) ? 'department' : 'manager'; }
function detectDept(qRaw) { const ql = String(qRaw || '').toLowerCase(); for (const [k, ids] of Object.entries(DEPT_ALIASES)) if (ql.includes(k)) return { ids, label: DEPARTMENT_LABELS[ids[0]] }; return null; }

// Win-rate + «честный пайплайн» по менеджерам или отделам.
async function runWinrates(qRaw) {
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const per = detectPeriod(qRaw);
  const group = detectGroup(qRaw);
  const dep = group === 'manager' ? detectDept(qRaw) : null;   // можно сузить менеджеров одним отделом
  const groupCol = group === 'department' ? 'department_id' : 'assigned_by_id';
  const closedWhere = [`(stage_id = ANY($1) OR stage_id = ANY($2))`, `COALESCE(contract_date,date_create) BETWEEN $3 AND $4`];
  const args = [CONTRACT_SET, LOST_SET, per.from, per.to];
  if (dep) { args.push(dep.ids); closedWhere.push(`department_id = ANY($${args.length})`); }
  // Итоги закрытых сделок по группам.
  const closed = await pool.query(
    `SELECT ${groupCol} g,
            COALESCE(SUM(${kzt}) FILTER (WHERE stage_id = ANY($1)),0) won_s, COUNT(*) FILTER (WHERE stage_id = ANY($1)) won_c,
            COALESCE(SUM(${kzt}) FILTER (WHERE stage_id = ANY($2)),0) lost_s, COUNT(*) FILTER (WHERE stage_id = ANY($2)) lost_c
     FROM ticketsmodule_stat_deals WHERE ${closedWhere.join(' AND ')} GROUP BY ${groupCol}`, args);
  // Открытый пайплайн сейчас по группам.
  const openArgs = [PRECONTRACT]; let openWhere = `stage_id = ANY($1)`;
  if (dep) { openArgs.push(dep.ids); openWhere += ` AND department_id = ANY($2)`; }
  const open = await pool.query(`SELECT ${groupCol} g, COALESCE(SUM(${kzt}),0) s, COUNT(*) c FROM ticketsmodule_stat_deals WHERE ${openWhere} GROUP BY ${groupCol}`, openArgs);
  const openMap = {}; open.rows.forEach(r => { openMap[r.g] = { sum: Math.round(parseFloat(r.s) || 0), count: parseInt(r.c, 10) }; });
  const label = g => group === 'department' ? (DEPARTMENT_LABELS[g] || String(g)) : (USERS[g] || ('#' + g));
  let rows = closed.rows.map(r => {
    const wonS = Math.round(parseFloat(r.won_s) || 0), lostS = Math.round(parseFloat(r.lost_s) || 0);
    const wonC = parseInt(r.won_c, 10), lostC = parseInt(r.lost_c, 10);
    const wrVal = (wonS + lostS) > 0 ? Math.round((wonS / (wonS + lostS)) * 100) : null;
    const wrCnt = (wonC + lostC) > 0 ? Math.round((wonC / (wonC + lostC)) * 100) : null;
    const op = openMap[r.g] || { sum: 0, count: 0 };
    const honest = wrVal != null ? Math.round(op.sum * wrVal / 100) : null;
    return { label: label(r.g), wonSum: wonS, wonCount: wonC, lostCount: lostC, winRate: wrVal, winRateCnt: wrCnt, openSum: op.sum, openCount: op.count, honest };
  }).filter(x => x.wonCount + x.lostCount > 0 || x.openSum > 0);
  rows.sort((a, b) => (b.winRate == null ? -1 : b.winRate) - (a.winRate == null ? -1 : a.winRate));
  const totWon = rows.reduce((s, x) => s + x.wonSum, 0);
  const totOpen = rows.reduce((s, x) => s + x.openSum, 0);
  const totHonest = rows.reduce((s, x) => s + (x.honest || 0), 0);
  return { winrate: true, group, period: per, deptLabel: dep && dep.label, rows: rows.slice(0, 25), totals: { won: totWon, open: totOpen, honest: totHonest } };
}

// Sales Velocity: (открытых сделок × win-rate × средний чек) / длина цикла.
async function runVelocity(qRaw) {
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const per = detectPeriod(qRaw);
  const dep = detectDept(qRaw);
  const scopeArgsClosed = [CONTRACT_SET, LOST_SET, per.from, per.to];
  let closedWhere = `(stage_id = ANY($1) OR stage_id = ANY($2)) AND COALESCE(contract_date,date_create) BETWEEN $3 AND $4`;
  if (dep) { scopeArgsClosed.push(dep.ids); closedWhere += ` AND department_id = ANY($${scopeArgsClosed.length})`; }
  const c = await pool.query(
    `SELECT COALESCE(SUM(${kzt}) FILTER (WHERE stage_id = ANY($1)),0) won_s, COUNT(*) FILTER (WHERE stage_id = ANY($1)) won_c,
            COUNT(*) FILTER (WHERE stage_id = ANY($2)) lost_c,
            AVG(EXTRACT(EPOCH FROM (contract_date - date_create))/86400) FILTER (WHERE stage_id = ANY($1) AND date_create IS NOT NULL AND contract_date IS NOT NULL) cycle
     FROM ticketsmodule_stat_deals WHERE ${closedWhere}`, scopeArgsClosed);
  const wonS = Math.round(parseFloat(c.rows[0].won_s) || 0), wonC = parseInt(c.rows[0].won_c, 10), lostC = parseInt(c.rows[0].lost_c, 10);
  const winRate = (wonC + lostC) > 0 ? wonC / (wonC + lostC) : 0;
  const avgDeal = wonC > 0 ? Math.round(wonS / wonC) : 0;
  const cycleDays = Math.max(1, Math.round(parseFloat(c.rows[0].cycle) || 60));
  const openArgs = [PRECONTRACT]; let openWhere = `stage_id = ANY($1)`;
  if (dep) { openArgs.push(dep.ids); openWhere += ` AND department_id = ANY($2)`; }
  const o = await pool.query(`SELECT COUNT(*) c, COALESCE(SUM(${kzt}),0) s FROM ticketsmodule_stat_deals WHERE ${openWhere}`, openArgs);
  const openCount = parseInt(o.rows[0].c, 10), openSum = Math.round(parseFloat(o.rows[0].s) || 0);
  const perDay = cycleDays > 0 ? Math.round(openCount * winRate * avgDeal / cycleDays) : 0;
  const perMonth = perDay * 30;
  return {
    velocity: true, period: per, scopeLabel: dep ? dep.label : 'вся компания',
    openCount, openSum, winRate: Math.round(winRate * 100), avgDeal, cycleDays, perDay, perMonth,
    wonCount: wonC, lostCount: lostC,
  };
}

module.exports = { looksLikeWinrate, looksLikeVelocity, runWinrates, runVelocity, LOST_SET, DEPARTMENT_LABELS };

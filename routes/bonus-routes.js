const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const { USERS } = require('../constants');

const PM_ROLES = ['admin', 'coordinator'];
function isPm(user) { return PM_ROLES.includes(user.role); }

// Resolves the current ЦУП account's Bitrix employee ID, the same way the
// planner does — via engineer_name -> USERS reverse lookup.
async function resolveBitrixIdForAccount(accountUserId) {
  const { rows } = await pool.query('SELECT engineer_name FROM ticketsmodule_users WHERE id=$1', [accountUserId]);
  const name = rows[0]?.engineer_name;
  if (!name) return null;
  const found = Object.entries(USERS).find(([, n]) => n === name);
  return found ? parseInt(found[0], 10) : null;
}

function quarterRange(year, quarter) {
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59));
  const fmt = d => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

// GET /api/bonus/calculate?year=2026&quarter=2[&engineerId=123]
// admin/coordinator can pass any engineerId (or omit for everyone);
// everyone else only ever sees their own numbers regardless of what they pass.
router.get('/calculate', requireAuth(), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const quarter = parseInt(req.query.quarter, 10);
    if (![1,2,3,4].includes(quarter)) return res.status(400).json({ error: 'Укажите квартал (1-4)' });

    const { start, end } = quarterRange(year, quarter);
    const { calculateQuarterBonuses } = require('../bonus-calc');
    const { byEngineer, skippedItems, totalReports, totalRequests } = await calculateQuarterBonuses(start, end);

    let result = byEngineer;
    if (!isPm(req.user)) {
      const myBitrixId = await resolveBitrixIdForAccount(req.user.id);
      result = myBitrixId && byEngineer[myBitrixId] ? { [myBitrixId]: byEngineer[myBitrixId] } : {};
    } else if (req.query.engineerId) {
      const id = parseInt(req.query.engineerId, 10);
      result = byEngineer[id] ? { [id]: byEngineer[id] } : {};
    }

    const withNames = Object.values(result).map(e => ({ ...e, engineerName: USERS[e.engineerId] || `#${e.engineerId}` }));
    withNames.sort((a,b) => b.totalKzt - a.totalKzt);

    res.json({
      year, quarter, period: { start, end },
      engineers: withNames,
      grandTotalKzt: withNames.reduce((s,e) => s + e.totalKzt, 0),
      totalReports,
      totalRequests,
      skippedCount: skippedItems.length,
      skipped: isPm(req.user) ? skippedItems : undefined,
    });
  } catch (e) {
    console.error('GET /api/bonus/calculate error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

module.exports = { router };

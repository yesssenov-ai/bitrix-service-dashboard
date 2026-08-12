const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator'];

// GET /api/contracts/summary?year=2026 — всё для вкладки одним запросом.
router.get('/summary', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { getContractsSummary } = require('../contracts-calc');
    res.json(await getContractsSummary(year));
  } catch (e) {
    console.error('GET /api/contracts/summary error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// POST /api/contracts/plan { year, department, amount } — правка плана (admin).
// amount — в ₸ (не в млн). Возвращает обновлённую сводку, чтобы фронт сразу
// перерисовал проценты/гейдж без второго запроса.
router.post('/plan', requireAuth(['admin']), express.json(), async (req, res) => {
  try {
    const year = parseInt(req.body.year, 10) || new Date().getFullYear();
    const department = String(req.body.department || '').trim();
    const amount = Number(req.body.amount);
    if (!department || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Нужны department и неотрицательный amount (в ₸)' });
    }
    const { setPlan, getContractsSummary } = require('../contracts-calc');
    await setPlan(year, department, amount);
    res.json({ ok: true, summary: await getContractsSummary(year) });
  } catch (e) {
    console.error('POST /api/contracts/plan error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

module.exports = { router };

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator'];

// GET /api/contracts/summary?year=2026 — плоский список сделок + план + мета.
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

// GET /api/contracts/news?mode=latest&limit=3 — самые свежие заключённые контракты;
// ?mode=window&days=3 — все заходы в «Контракт»/«Завершена» за N дней (по убыванию).
router.get('/news', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getRecentNews, getLatestContracts } = require('../contracts-calc');
    if (req.query.mode === 'window') {
      const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 3));
      return res.json({ mode: 'window', days, items: await getRecentNews(days) });
    }
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 3));
    res.json({ mode: 'latest', items: await getLatestContracts(limit) });
  } catch (e) {
    console.error('GET /api/contracts/news error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// POST /api/contracts/plan { year, department, amount } — правка плана (admin), ₸.
router.post('/plan', requireAuth(['admin']), express.json(), async (req, res) => {
  try {
    const year = parseInt(req.body.year, 10) || new Date().getFullYear();
    const department = String(req.body.department || '').trim();
    const amount = Number(req.body.amount);
    if (!department || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Нужны department и неотрицательный amount (в ₸)' });
    }
    const { setPlan, getPlan } = require('../contracts-calc');
    await setPlan(year, department, amount);
    res.json({ ok: true, planMap: await getPlan(year) });
  } catch (e) {
    console.error('POST /api/contracts/plan error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

module.exports = { router };

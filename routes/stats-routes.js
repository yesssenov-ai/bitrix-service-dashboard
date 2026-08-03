const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const PM_ROLES = ['admin', 'coordinator'];

function yearRange(year) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// GET /api/stats/summary?year=2026
router.get('/summary', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { start, end } = yearRange(year);
    const { getWonDealsInRange, summarizeByManufacturerAndType } = require('../stats-calc');
    const deals = await getWonDealsInRange(start, end);
    const summary = summarizeByManufacturerAndType(deals);
    res.json({ year, dealCount: deals.length, ...summary });
  } catch (e) {
    console.error('GET /api/stats/summary error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/stats/managers?year=2026
router.get('/managers', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { start, end } = yearRange(year);
    const { getWonDealsInRange, summarizeByManager } = require('../stats-calc');
    const deals = await getWonDealsInRange(start, end);
    res.json({ year, managers: summarizeByManager(deals) });
  } catch (e) {
    console.error('GET /api/stats/managers error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/stats/instruments?year=2026
router.get('/instruments', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { start, end } = yearRange(year);
    const { getWonDealsInRange, summarizeByInstrument } = require('../stats-calc');
    const deals = await getWonDealsInRange(start, end);
    res.json({ year, instruments: summarizeByInstrument(deals) });
  } catch (e) {
    console.error('GET /api/stats/instruments error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

module.exports = { router };

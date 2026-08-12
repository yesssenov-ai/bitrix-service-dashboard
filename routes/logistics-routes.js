const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator'];

// GET /api/logistics/board — все заказы с вехами, ETA, прогрессом (кэш 10 мин).
router.get('/board', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getBoard } = require('../logistics-calc');
    res.json(await getBoard(req.query.force === '1'));
  } catch (e) {
    console.error('GET /api/logistics/board error:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить: ' + e.message });
  }
});

module.exports = { router };

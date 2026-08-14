const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const ROLES = ['admin', 'coordinator'];

// GET /api/procurement/meta — стадии + справочники для формы (кэш 30 мин, ?force=1)
router.get('/meta', requireAuth(ROLES), async (req, res) => {
  try {
    const { getMeta } = require('../procurement-calc');
    res.json(await getMeta(req.query.force === '1'));
  } catch (e) {
    console.error('GET /api/procurement/meta error:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить справочники: ' + e.message });
  }
});

// GET /api/procurement/deals?q=... — поиск сделок для привязки
router.get('/deals', requireAuth(ROLES), async (req, res) => {
  try {
    const { searchDeals } = require('../procurement-calc');
    res.json({ items: await searchDeals(req.query.q) });
  } catch (e) {
    console.error('GET /api/procurement/deals error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// GET /api/procurement/list — наши заявки (из локальной таблицы)
router.get('/list', requireAuth(ROLES), async (req, res) => {
  try {
    const { listRequests } = require('../procurement-calc');
    res.json({ items: await listRequests() });
  } catch (e) {
    console.error('GET /api/procurement/list error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// POST /api/procurement/create — создать заявку: локально + элемент в 1066
router.post('/create', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { createRequest } = require('../procurement-calc');
    const payload = req.body || {};
    payload._createdBy = req.user.id;
    const out = await createRequest(payload, req.user.bitrix_user_id || null);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('POST /api/procurement/create error:', e.message);
    res.status(500).json({ error: 'Не удалось создать заявку: ' + e.message });
  }
});

// POST /api/procurement/:id/stage { stageKey } — двигать заявку по 7-шаговому процессу
router.post('/:id/stage', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { moveStage } = require('../procurement-calc');
    const id = parseInt(req.params.id, 10);
    const out = await moveStage(id, req.body && req.body.stageKey);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('POST /api/procurement/:id/stage error:', e.message);
    res.status(500).json({ error: 'Не удалось сменить стадию: ' + e.message });
  }
});

module.exports = { router };

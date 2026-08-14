const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const ROLES = ['admin', 'coordinator'];

// GET /api/procurement/meta — стадии + справочники для формы (кэш 30 мин, ?force=1)
router.get('/meta', requireAuth(ROLES), async (req, res) => {
  try {
    const { getMeta } = require('../procurement-calc');
    const meta = await getMeta(req.query.force === '1');
    res.json({ ...meta, me: { bitrixUserId: req.user.bitrix_user_id || null, name: req.user.display_name } });
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

// PUT /api/procurement/:id — редактирование базовых полей заявки
router.put('/:id', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { updateRequest } = require('../procurement-calc');
    res.json(await updateRequest(parseInt(req.params.id, 10), req.body || {}));
  } catch (e) {
    console.error('PUT /api/procurement/:id error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

// DELETE /api/procurement/:id — удалить заявку и элемент 1066
router.delete('/:id', requireAuth(ROLES), async (req, res) => {
  try {
    const { deleteRequest } = require('../procurement-calc');
    res.json(await deleteRequest(parseInt(req.params.id, 10)));
  } catch (e) {
    console.error('DELETE /api/procurement/:id error:', e.message);
    res.status(500).json({ error: 'Не удалось удалить: ' + e.message });
  }
});

// GET /api/procurement/:id/detail — документы + согласование (из 1066)
router.get('/:id/detail', requireAuth(ROLES), async (req, res) => {
  try {
    const { getItemDetail } = require('../procurement-calc');
    res.json(await getItemDetail(parseInt(req.params.id, 10)));
  } catch (e) {
    console.error('GET /api/procurement/:id/detail error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/procurement/:id/upload { fieldCode, filename, base64 } — загрузка документа
router.post('/:id/upload', requireAuth(ROLES), express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const { uploadDoc } = require('../procurement-calc');
    const { fieldCode, filename, base64 } = req.body || {};
    if (!fieldCode || !base64) return res.status(400).json({ error: 'Нужны fieldCode и base64' });
    res.json(await uploadDoc(parseInt(req.params.id, 10), fieldCode, filename || 'file', base64));
  } catch (e) {
    console.error('POST /api/procurement/:id/upload error:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить: ' + e.message });
  }
});

// POST /api/procurement/:id/request-approval { approverId } — отправить на согласование
router.post('/:id/request-approval', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { requestApproval } = require('../procurement-calc');
    res.json(await requestApproval(parseInt(req.params.id, 10), (req.body || {}).approverId));
  } catch (e) {
    console.error('POST /api/procurement/:id/request-approval error:', e.message);
    res.status(500).json({ error: 'Не удалось отправить на согласование: ' + e.message });
  }
});

// POST /api/procurement/:id/approval { status, approverId, comment } — решение по согласованию
router.post('/:id/approval', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { setApproval } = require('../procurement-calc');
    const { status, approverId, comment } = req.body || {};
    res.json(await setApproval(parseInt(req.params.id, 10), status, approverId, comment));
  } catch (e) {
    console.error('POST /api/procurement/:id/approval error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить согласование: ' + e.message });
  }
});

// POST /api/procurement/:id/accountant { accountantBid } — сменить бухгалтера на оплату
router.post('/:id/accountant', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { setAccountant } = require('../procurement-calc');
    res.json(await setAccountant(parseInt(req.params.id, 10), (req.body || {}).accountantBid));
  } catch (e) {
    console.error('POST /api/procurement/:id/accountant error:', e.message);
    res.status(500).json({ error: 'Не удалось сменить бухгалтера: ' + e.message });
  }
});

module.exports = { router };

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { getBoard, getDealDetail } = require('../operational');
const { refresh: refreshOperationalCache } = require('../operational-sync');

// Same access level as Статистика — this is a management / meeting view.
const OPS_ROLES = ['admin', 'coordinator'];

function parseFilters(q) {
  const filters = {};
  if (q.categories) {
    filters.categoryIds = String(q.categories).split(',').map(s => parseInt(s, 10)).filter(n => !Number.isNaN(n));
  }
  if (q.department && q.department !== 'all') filters.departmentId = q.department;
  if (q.manager && q.manager !== 'all')       filters.managerId = parseInt(q.manager, 10);
  if (q.company && q.company !== 'all')        filters.companyId = parseInt(q.company, 10);
  if (q.stage && q.stage !== 'all')            filters.stageId = q.stage;
  if (q.customer)                              filters.customerQuery = String(q.customer);
  if (q.year && q.year !== 'all')              filters.year = parseInt(q.year, 10);
  if (q.month && q.month !== 'all')            filters.month = parseInt(q.month, 10);
  return filters;
}

// GET /api/operational/board — funnel + detail rows + filter options
router.get('/board', requireAuth(OPS_ROLES), async (req, res) => {
  try {
    const board = await getBoard(parseFilters(req.query));
    res.json(board);
  } catch (e) {
    console.error('GET /api/operational/board error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось собрать операционную сводку: ' + e.message });
  }
});

// GET /api/operational/deal/:id — drill-down (child processes, tasks, comments)
router.get('/deal/:id', requireAuth(OPS_ROLES), async (req, res) => {
  try {
    const dealId = parseInt(req.params.id, 10);
    if (!dealId) return res.status(400).json({ ok: false, error: 'Неверный ID сделки' });
    const detail = await getDealDetail(dealId);
    res.json(detail);
  } catch (e) {
    console.error('GET /api/operational/deal error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось загрузить детали сделки: ' + e.message });
  }
});

// POST /api/operational/refresh — manual full re-pull (button on the page).
// Deal-level rows are refreshed synchronously (fast); automation counts
// recompute in the background, so the response returns promptly.
router.post('/refresh', requireAuth(OPS_ROLES), async (req, res) => {
  try {
    const result = await refreshOperationalCache();
    const board = await getBoard(parseFilters(req.query));
    res.json({ ok: true, refreshed: result, ...board });
  } catch (e) {
    console.error('POST /api/operational/refresh error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось обновить данные: ' + e.message });
  }
});

module.exports = { router };

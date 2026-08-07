const express = require('express');
const router = express.Router();
const { b24 } = require('../bitrix');
const { requireAuth, auditLog } = require('../auth');
const { getBoard, getDealDetail, getEditMeta, invalidateDealDetail, F } = require('../operational');
const { refresh: refreshOperationalCache, syncOneDeal } = require('../operational-sync');
const { buildPdf, buildXlsx } = require('../operational-export');

// Same access level as Статистика — this is a management / meeting view.
const OPS_ROLES = ['admin', 'coordinator'];
// Editing deals (stage/responsible/comment/task) is admin-only.
const ADMIN_ONLY = ['admin'];

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

// GET /api/operational/deal/:id — drill-down, served from cache (built lazily).
router.get('/deal/:id', requireAuth(OPS_ROLES), async (req, res) => {
  try {
    const dealId = parseInt(req.params.id, 10);
    if (!dealId) return res.status(400).json({ ok: false, error: 'Неверный ID сделки' });
    const detail = await getDealDetail(dealId, false);
    res.json(detail);
  } catch (e) {
    console.error('GET /api/operational/deal error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось загрузить детали сделки: ' + e.message });
  }
});

// POST /api/operational/deal/:id/refresh — force a live rebuild of the drill-down.
router.post('/deal/:id/refresh', requireAuth(OPS_ROLES), async (req, res) => {
  try {
    const dealId = parseInt(req.params.id, 10);
    if (!dealId) return res.status(400).json({ ok: false, error: 'Неверный ID сделки' });
    const detail = await getDealDetail(dealId, true);
    res.json(detail);
  } catch (e) {
    console.error('POST /api/operational/deal/:id/refresh error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось обновить детали сделки: ' + e.message });
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

// ── Export (PDF / XLSX, simple / detailed) — respects current filters ────────
function buildFilterText(q, board) {
  const parts = [];
  if (q.categories) parts.push('Воронка: ' + String(q.categories).split(',').map(c => (board.pipelines && board.pipelines[c]) || c).join(', '));
  if (q.stage && q.stage !== 'all') parts.push('Стадия: ' + q.stage);
  if (q.department && q.department !== 'all') parts.push('Отдел: ' + ((board.departments && board.departments[q.department]) || q.department));
  if (q.manager && q.manager !== 'all') { const m = (board.options && board.options.managers || []).find(x => String(x.id) === String(q.manager)); parts.push('Менеджер: ' + (m ? m.name : q.manager)); }
  if (q.customer) parts.push('Заказчик: ' + q.customer);
  if (q.year && q.year !== 'all') parts.push('Период: ' + q.year + (q.month && q.month !== 'all' ? '/' + q.month : ''));
  if (q.flag) parts.push('Признак: ' + q.flag);
  return parts.join('   ·   ');
}

router.get('/export', requireAuth(OPS_ROLES), async (req, res) => {
  try {
    const format = req.query.format === 'xlsx' ? 'xlsx' : 'pdf';
    const type = req.query.type === 'detailed' ? 'detailed' : 'simple';
    const board = await getBoard(parseFilters(req.query));
    let rows = board.rows || [];
    if (req.query.flag) rows = rows.filter(r => (r.flags || []).includes(req.query.flag));

    const meta = { date: new Date().toLocaleString('ru-RU'), filterText: buildFilterText(req.query, board), detailsMap: {} };
    if (type === 'detailed') {
      for (const r of rows.slice(0, 300)) { try { meta.detailsMap[r.id] = await getDealDetail(r.id, false); } catch (e) { /* skip one */ } }
    }

    let buf, ct, ext;
    if (format === 'xlsx') { buf = buildXlsx({ board, rows, type, meta }); ct = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ext = 'xlsx'; }
    else { buf = await buildPdf({ board, rows, type, meta }); ct = 'application/pdf'; ext = 'pdf'; }

    const fname = `Реализация_${type === 'detailed' ? 'детальный' : 'простой'}_${new Date().toISOString().slice(0, 10)}.${ext}`;
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (e) {
    console.error('GET /api/operational/export error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось сформировать экспорт: ' + e.message });
  }
});

// ── Admin edit actions ───────────────────────────────────────────────────────
// GET /api/operational/meta — stage + user options for the admin edit forms.
router.get('/meta', requireAuth(ADMIN_ONLY), async (req, res) => {
  try { res.json({ ok: true, ...(await getEditMeta()) }); }
  catch (e) { console.error('GET /api/operational/meta error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

async function resyncDeal(dealId) {
  try { await syncOneDeal(dealId); } catch (e) { console.error('resyncDeal error:', e.message); }
}

// POST /deal/:id/stage — change deal stage
router.post('/deal/:id/stage', requireAuth(ADMIN_ONLY), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const stageId = req.body.stageId;
    if (!id || !stageId) return res.status(400).json({ ok: false, error: 'Не указаны параметры' });
    await b24('crm.deal.update', { id, fields: { STAGE_ID: stageId } });
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_STAGE', id, { stageId }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    await resyncDeal(id);
    res.json({ ok: true });
  } catch (e) { console.error('stage edit error:', e.message); res.status(500).json({ ok: false, error: 'Не удалось сменить стадию: ' + e.message }); }
});

// POST /deal/:id/responsible — change responsible (ASSIGNED_BY_ID)
router.post('/deal/:id/responsible', requireAuth(ADMIN_ONLY), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const userId = parseInt(req.body.userId, 10);
    if (!id || !userId) return res.status(400).json({ ok: false, error: 'Не указаны параметры' });
    await b24('crm.deal.update', { id, fields: { ASSIGNED_BY_ID: userId } });
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_RESPONSIBLE', id, { userId }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    await resyncDeal(id);
    res.json({ ok: true });
  } catch (e) { console.error('responsible edit error:', e.message); res.status(500).json({ ok: false, error: 'Не удалось сменить ответственного: ' + e.message }); }
});

// POST /deal/:id/redflag — toggle the «Красный флаг» boolean field
router.post('/deal/:id/redflag', requireAuth(ADMIN_ONLY), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Неверный ID' });
    if (!F.redFlag) return res.status(400).json({ ok: false, error: 'Поле красного флага не настроено' });
    const value = req.body.value === true || req.body.value === 'true' || req.body.value === 1 || req.body.value === '1';
    await b24('crm.deal.update', { id, fields: { [F.redFlag]: value ? '1' : '0' } });
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_REDFLAG', id, { value }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    await resyncDeal(id);
    res.json({ ok: true, value });
  } catch (e) { console.error('redflag error:', e.message); res.status(500).json({ ok: false, error: 'Не удалось изменить красный флаг: ' + e.message }); }
});

// POST /deal/:id/comment — add a timeline comment
router.post('/deal/:id/comment', requireAuth(ADMIN_ONLY), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const text = (req.body.text || '').trim();
    if (!id || !text) return res.status(400).json({ ok: false, error: 'Пустой комментарий' });
    await b24('crm.timeline.comment.add', { fields: { ENTITY_ID: id, ENTITY_TYPE: 'deal', COMMENT: `💬 ${req.user.display_name}: ${text}` } });
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_COMMENT', id, { text: text.slice(0, 100) }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    await invalidateDealDetail(id);
    res.json({ ok: true });
  } catch (e) { console.error('comment error:', e.message); res.status(500).json({ ok: false, error: 'Не удалось добавить комментарий: ' + e.message }); }
});

// POST /deal/:id/task — create a Bitrix task bound to the deal
router.post('/deal/:id/task', requireAuth(ADMIN_ONLY), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { title, responsibleId, deadline, description } = req.body;
    if (!id || !title) return res.status(400).json({ ok: false, error: 'Не указано название задачи' });
    const data = await b24('tasks.task.add', { fields: {
      TITLE: title,
      DESCRIPTION: description || '',
      RESPONSIBLE_ID: parseInt(responsibleId, 10) || 1,
      DEADLINE: deadline || '',
      UF_CRM_TASK: [`D_${id}`],
    }});
    const taskId = data.result?.task?.id;
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_TASK', id, { taskId, title }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    await invalidateDealDetail(id);
    res.json({ ok: true, taskId });
  } catch (e) { console.error('task error:', e.message); res.status(500).json({ ok: false, error: 'Не удалось создать задачу: ' + e.message }); }
});

module.exports = { router };

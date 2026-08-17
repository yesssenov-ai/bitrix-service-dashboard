const express = require('express');
const router = express.Router();
const { b24 } = require('../bitrix');
const { requireAuth, auditLog, pool } = require('../auth');
const { getBoard, getDealDetail, getEditMeta, invalidateDealDetail, F } = require('../operational');
const { refresh: refreshOperationalCache, syncOneDeal, updateFactoryShipDate } = require('../operational-sync');
const { buildPdf, buildXlsx } = require('../operational-export');

// ── Role capabilities inside this module ─────────────────────────────────────
// admin always has everything (never stored). Every other role's access is
// configured in the module's internal admin panel and lives in
// ticketsmodule_operational_perms. Capabilities: view (open the module) + the
// five edit actions.
const EDIT_CAPS = ['stage', 'responsible', 'redflag', 'comment', 'task', 'dates'];
const ALL_CAPS = ['view', ...EDIT_CAPS];
const EDITABLE_ROLES = ['coordinator', 'engineer', 'viewer']; // admin excluded (implicit full)
const ROLE_LABELS = { coordinator: 'Координатор', engineer: 'Инженер', viewer: 'Наблюдатель' };
const CAP_LABELS = { view: 'Просмотр', stage: 'Стадия', responsible: 'Ответств.', redflag: 'Кр. флаг', comment: 'Коммент.', task: 'Задачи', dates: 'Даты' };

let _permCache = null, _permCacheAt = 0;
async function getPermsMap() {
  if (_permCache && Date.now() - _permCacheAt < 15000) return _permCache;
  const map = {};
  try {
    const { rows } = await pool.query('SELECT * FROM ticketsmodule_operational_perms');
    rows.forEach(r => { map[r.role] = { view: r.can_view, stage: r.can_stage, responsible: r.can_responsible, redflag: r.can_redflag, comment: r.can_comment, task: r.can_task, dates: r.can_dates }; });
  } catch (e) { console.error('getPermsMap error:', e.message); }
  _permCache = map; _permCacheAt = Date.now();
  return map;
}
function invalidatePerms() { _permCache = null; }

async function userCan(user, cap) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const map = await getPermsMap();
  return !!(map[user.role] && map[user.role][cap]);
}

// Middleware: authenticate, then require a module capability.
function requireCap(cap) {
  return [requireAuth(), async (req, res, next) => {
    try {
      if (await userCan(req.user, cap)) return next();
      return res.status(403).json({ ok: false, error: 'Недостаточно прав для этого действия' });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }];
}

const splitInts = s => String(s).split(',').map(x => parseInt(x, 10)).filter(n => !Number.isNaN(n));
const splitStrs = s => String(s).split(',').map(x => x.trim()).filter(x => x && x !== 'all');

// All list-style filters accept a comma-separated set of values (multi-select).
function parseFilters(q) {
  const filters = {};
  if (q.categories)                     filters.categoryIds = splitInts(q.categories);
  if (q.department && q.department !== 'all') filters.departmentIds = splitStrs(q.department);
  if (q.manager && q.manager !== 'all')       filters.managerIds = splitInts(q.manager);
  if (q.company && q.company !== 'all')        filters.companyId = parseInt(q.company, 10);
  if (q.stage && q.stage !== 'all')            filters.stageIds = splitStrs(q.stage);
  if (q.customer)                              filters.customerQuery = String(q.customer);
  if (q.year && q.year !== 'all')              filters.years = splitInts(q.year);
  if (q.month && q.month !== 'all')            filters.months = splitInts(q.month);
  return filters;
}

// GET /api/operational/board — funnel + detail rows + filter options
router.get('/board', requireCap('view'), async (req, res) => {
  try {
    const board = await getBoard(parseFilters(req.query));
    res.json(board);
  } catch (e) {
    console.error('GET /api/operational/board error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось собрать операционную сводку: ' + e.message });
  }
});

// GET /api/operational/deal/:id — drill-down, served from cache (built lazily).
router.get('/deal/:id', requireCap('view'), async (req, res) => {
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
router.post('/deal/:id/refresh', requireCap('view'), async (req, res) => {
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
router.post('/refresh', requireCap('view'), async (req, res) => {
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
  const list = v => String(v).split(',').map(x => x.trim()).filter(x => x && x !== 'all');
  const depName = id => (board.departments && board.departments[id]) || id;
  const mgrName = id => { const m = (board.options && board.options.managers || []).find(x => String(x.id) === String(id)); return m ? m.name : id; };
  if (q.categories) parts.push('Воронка: ' + list(q.categories).map(c => (board.pipelines && board.pipelines[c]) || c).join(', '));
  if (q.stage && q.stage !== 'all') parts.push('Стадия: ' + list(q.stage).join(', '));
  if (q.department && q.department !== 'all') parts.push('Отдел: ' + list(q.department).map(depName).join(', '));
  if (q.manager && q.manager !== 'all') parts.push('Менеджер: ' + list(q.manager).map(mgrName).join(', '));
  if (q.customer) parts.push('Заказчик: ' + q.customer);
  if (q.year && q.year !== 'all') parts.push('Год: ' + list(q.year).join(', ') + (q.month && q.month !== 'all' ? '   ·   Месяц: ' + list(q.month).join(', ') : ''));
  if (q.flag) parts.push('Признак: ' + q.flag);
  return parts.join('   ·   ');
}

router.get('/export', requireCap('view'), async (req, res) => {
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

// ── Отчёт для руководства («отчёт по оперативке») ────────────────────────────
// GET /api/operational/report?format=html|pdf — экзекьютив-сводка (RAG, флаги,
// изменения, ближайшие поставки). HTML открывается в браузере, PDF скачивается.
router.get('/report', requireCap('view'), async (req, res) => {
  try {
    const { computeReport, renderHtml, buildPdf } = require('../operational-report');
    const rep = await computeReport({ commit: false });
    if (req.query.format === 'pdf') {
      const buf = await buildPdf(rep);
      const fname = `Операционный_отчёт_${new Date().toISOString().slice(0, 10)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
      return res.send(buf);
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderHtml(rep));
  } catch (e) {
    console.error('GET /api/operational/report error:', e.message);
    res.status(500).send('Не удалось сформировать отчёт: ' + e.message);
  }
});

// POST /api/operational/report/send — собрать отчёт, зафиксировать снимок (для
// дельт следующего отчёта) и разослать руководству (Resend, HTML + PDF). Тело:
// { recipients?: "a@b,c@d" } — иначе берём OPS_REPORT_RECIPIENTS.
router.post('/report/send', requireAuth(['admin']), express.json(), async (req, res) => {
  try {
    const { computeReport, renderHtml, buildPdf, sendReportEmail, recipientsFromEnv } = require('../operational-report');
    const recipients = (req.body && req.body.recipients ? String(req.body.recipients).split(',').map(s => s.trim()).filter(Boolean) : null) || recipientsFromEnv();
    const rep = await computeReport({ commit: true });
    const [html, pdf] = await Promise.all([Promise.resolve(renderHtml(rep)), buildPdf(rep)]);
    const out = await sendReportEmail(recipients, rep, html, pdf);
    if (!out.ok) return res.status(500).json({ ok: false, error: out.error });
    res.json({ ok: true, sentTo: out.to, status: rep.status });
  } catch (e) {
    console.error('POST /api/operational/report/send error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось отправить отчёт: ' + e.message });
  }
});

// ── Admin edit actions ───────────────────────────────────────────────────────
// GET /api/operational/meta — stage + user options for the admin edit forms.
router.get('/meta', requireCap('view'), async (req, res) => {
  try { res.json({ ok: true, ...(await getEditMeta()) }); }
  catch (e) { console.error('GET /api/operational/meta error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/operational/my-access — what the CURRENT user may do here. Drives the
// frontend (whether to show the pencil / which edit controls to render).
router.get('/my-access', requireAuth(), async (req, res) => {
  try {
    const caps = {};
    for (const c of ALL_CAPS) caps[c] = await userCan(req.user, c);
    res.json({ ok: true, role: req.user.role, isAdmin: req.user.role === 'admin', caps });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/operational/permissions — role→capability matrix (admin only).
router.get('/permissions', requireAuth(['admin']), async (req, res) => {
  try {
    const map = await getPermsMap();
    const empty = { view: false, stage: false, responsible: false, redflag: false, comment: false, task: false, dates: false };
    const roles = EDITABLE_ROLES.map(role => ({ role, label: ROLE_LABELS[role] || role, caps: map[role] || { ...empty } }));
    res.json({ ok: true, capsOrder: ALL_CAPS, capLabels: CAP_LABELS, roles });
  } catch (e) { console.error('GET /permissions error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// PUT /api/operational/permissions — save the matrix (admin only).
router.put('/permissions', requireAuth(['admin']), async (req, res) => {
  const updates = Array.isArray(req.body?.roles) ? req.body.roles : null;
  if (!updates) return res.status(400).json({ ok: false, error: 'Нет данных для сохранения' });
  try {
    for (const u of updates) {
      if (!EDITABLE_ROLES.includes(u.role)) continue;
      const c = u.caps || {};
      await pool.query(
        `INSERT INTO ticketsmodule_operational_perms (role, can_view, can_stage, can_responsible, can_redflag, can_comment, can_task, can_dates)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (role) DO UPDATE SET can_view=$2, can_stage=$3, can_responsible=$4, can_redflag=$5, can_comment=$6, can_task=$7, can_dates=$8`,
        [u.role, !!c.view, !!c.stage, !!c.responsible, !!c.redflag, !!c.comment, !!c.task, !!c.dates]
      );
    }
    invalidatePerms();
    await auditLog(req.user.id, req.user.username, 'OP_PERMS_UPDATE', null, { roles: updates.map(u => u.role) }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) { console.error('PUT /permissions error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

async function resyncDeal(dealId) {
  try { await syncOneDeal(dealId); } catch (e) { console.error('resyncDeal error:', e.message); }
}

// POST /deal/:id/stage — change deal stage
router.post('/deal/:id/stage', requireCap('stage'), async (req, res) => {
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
router.post('/deal/:id/responsible', requireCap('responsible'), async (req, res) => {
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

// Accepts '', null, or 'YYYY-MM-DD'; rejects anything else.
function normDate(v) {
  if (v == null || v === '') return '';
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// POST /deal/:id/delivery-date — «Срок поставки заказа по договору» (deal field)
router.post('/deal/:id/delivery-date', requireCap('dates'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Неверный ID' });
    if (!F.deliveryByDate) return res.status(400).json({ ok: false, error: 'Поле «Поставка по договору» не настроено' });
    const date = normDate(req.body.date);
    if (date === null) return res.status(400).json({ ok: false, error: 'Неверная дата' });
    await b24('crm.deal.update', { id, fields: { [F.deliveryByDate]: date } });
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_DELIVERY_DATE', id, { date }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    await resyncDeal(id);
    res.json({ ok: true });
  } catch (e) { console.error('delivery-date error:', e.message); res.status(500).json({ ok: false, error: 'Не удалось изменить дату поставки: ' + e.message }); }
});

// POST /deal/:id/factory-ship — «Дата отгрузки от завода» (lives on Закупки 1066)
router.post('/deal/:id/factory-ship', requireCap('dates'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Неверный ID' });
    const date = normDate(req.body.date);
    if (date === null) return res.status(400).json({ ok: false, error: 'Неверная дата' });
    await updateFactoryShipDate(id, date);
    await auditLog(req.user.id, req.user.username, 'OP_DEAL_FACTORY_SHIP', id, { date }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) {
    console.error('factory-ship error:', e.message);
    res.status(e.userFacing ? 400 : 500).json({ ok: false, error: (e.userFacing ? e.message : 'Не удалось изменить дату отгрузки: ' + e.message) });
  }
});

// POST /deal/:id/redflag — toggle the «Красный флаг» boolean field
router.post('/deal/:id/redflag', requireCap('redflag'), async (req, res) => {
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
router.post('/deal/:id/comment', requireCap('comment'), async (req, res) => {
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
router.post('/deal/:id/task', requireCap('task'), async (req, res) => {
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

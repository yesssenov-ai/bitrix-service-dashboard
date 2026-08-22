const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

// Доступ к модулю «Закупки»: admin, coordinator и store правят закупки.
const ROLES = ['admin', 'coordinator', 'store'];
// Просмотр + согласование: те же + engineer/sales (видит ТОЛЬКО свои закупки —
// где он согласующий/ответственный/инициатор; правами на правку не наделяется,
// но может согласовывать назначенные на него закупки).
const VIEW_ROLES = ['admin', 'coordinator', 'store', 'engineer', 'accountant'];
// Роли, которые видят/согласовывают ТОЛЬКО свои закупки (без прав на правку).
const OWN_ONLY = ['engineer', 'accountant'];
// Удаление закупок — БЕЗ store (store может всё, кроме удаления).
const DEL_ROLES = ['admin', 'coordinator'];

// GET /api/procurement/meta — стадии + справочники для формы (кэш 30 мин, ?force=1)
router.get('/meta', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getMeta } = require('../procurement-calc');
    const meta = await getMeta(req.query.force === '1');
    res.json({ ...meta, me: { bitrixUserId: req.user.bitrix_user_id || null, name: req.user.display_name, role: req.user.role } });
  } catch (e) {
    console.error('GET /api/procurement/meta error:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить справочники: ' + e.message });
  }
});

// GET /api/procurement/by-deal?dealId=... — все закупки по сделке + статусы
router.get('/by-deal', requireAuth(ROLES), async (req, res) => {
  try {
    const { listByDeal } = require('../procurement-calc');
    res.json(await listByDeal(req.query.dealId));
  } catch (e) {
    console.error('GET /api/procurement/by-deal error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
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

// GET /api/procurement/companies?q=... — поиск компаний в CRM (по названию/БИН)
router.get('/companies', requireAuth(ROLES), async (req, res) => {
  try {
    const { searchCompanies } = require('../procurement-calc');
    res.json({ items: await searchCompanies(req.query.q) });
  } catch (e) {
    console.error('GET /api/procurement/companies error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// GET /api/procurement/bin?bin=... — резолв БИН через ГБД ЮЛ + матч в CRM
router.get('/bin', requireAuth(ROLES), async (req, res) => {
  try {
    const { resolveBin } = require('../procurement-calc');
    res.json(await resolveBin(req.query.bin));
  } catch (e) {
    console.error('GET /api/procurement/bin error:', e.message);
    res.status(500).json({ found: false, error: e.message });
  }
});

// GET /api/procurement/list — наши заявки (из локальной таблицы)
router.get('/list', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { listRequests } = require('../procurement-calc');
    // engineer/sales и бухгалтер видят только свои закупки; остальные роли — все.
    const ownerBid = OWN_ONLY.includes(req.user.role) ? (req.user.bitrix_user_id || -1) : null;
    res.json({ items: await listRequests(ownerBid) });
  } catch (e) {
    console.error('GET /api/procurement/list error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// GET /api/procurement/deletions — журнал удалённых закупок (админ)
router.get('/deletions', requireAuth(['admin']), async (req, res) => {
  try {
    const { listDeletions } = require('../procurement-calc');
    res.json({ items: await listDeletions(req.query.limit) });
  } catch (e) {
    console.error('GET /api/procurement/deletions error:', e.message);
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
    const body = req.body || {};
    // Админ может пропускать стадии (force) — шлюзы требований не проверяются.
    const out = await moveStage(id, body.stageKey, { reason: body.reason, byBid: req.user.bitrix_user_id || null, force: req.user.role === 'admin' });
    res.json({ ok: true, ...out });
  } catch (e) {
    // needReason → фронт покажет запрос причины отката (не как обычную ошибку).
    const status = e.userFacing ? 400 : 500;
    if (!e.userFacing) console.error('POST /api/procurement/:id/stage error:', e.message);
    res.status(status).json({ error: e.message, needReason: !!e.needReason });
  }
});

// POST /api/procurement/:id/files — добавить файл в слот (множественно) + метаданные накладной
router.post('/:id/files', requireAuth(VIEW_ROLES), express.json({ limit: '45mb' }), async (req, res) => {
  try {
    const { addFile } = require('../procurement-calc');
    const id = parseInt(req.params.id, 10);
    const { slot, filename, base64, mime, warehouse, acceptDate, comment } = req.body || {};
    if (!slot || !base64) return res.status(400).json({ error: 'Нужны slot и base64' });
    const out = await addFile(id, slot, { filename: filename || 'file', base64, mime, warehouse, acceptDate, comment }, req.user.bitrix_user_id || null);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('POST /api/procurement/:id/files error:', e.message);
    res.status(e.userFacing ? 400 : 500).json({ error: 'Не удалось загрузить: ' + e.message });
  }
});

// POST /api/procurement/:id/files-batch — загрузить несколько файлов в слот за раз
router.post('/:id/files-batch', requireAuth(VIEW_ROLES), express.json({ limit: '90mb' }), async (req, res) => {
  try {
    const { addFilesBatch } = require('../procurement-calc');
    const id = parseInt(req.params.id, 10);
    const { slot, files } = req.body || {};
    if (!slot || !Array.isArray(files) || !files.length) return res.status(400).json({ error: 'Нужны slot и files[]' });
    const out = await addFilesBatch(id, slot, files, req.user.bitrix_user_id || null);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('POST /api/procurement/:id/files-batch error:', e.message);
    res.status(e.userFacing ? 400 : 500).json({ error: 'Не удалось загрузить: ' + e.message });
  }
});

// GET /api/procurement/:id/files/:fileId/download — скачать файл
router.get('/:id/files/:fileId/download', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getFileBytes } = require('../procurement-calc');
    const f = await getFileBytes(parseInt(req.params.id, 10), parseInt(req.params.fileId, 10));
    if (!f) return res.status(404).send('Файл не найден');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.send(f.buffer);
  } catch (e) {
    console.error('GET /api/procurement/:id/files/:fileId/download error:', e.message);
    res.status(500).send('Ошибка');
  }
});

// DELETE /api/procurement/:id/files/:fileId — удалить файл
router.delete('/:id/files/:fileId', requireAuth(ROLES), async (req, res) => {
  try {
    const { removeFile } = require('../procurement-calc');
    res.json(await removeFile(parseInt(req.params.id, 10), parseInt(req.params.fileId, 10)));
  } catch (e) {
    console.error('DELETE /api/procurement/:id/files/:fileId error:', e.message);
    res.status(500).json({ error: 'Не удалось удалить файл: ' + e.message });
  }
});

// ── Отгрузка по сделке (ТТН + доотправка) ────────────────────────────────────
// POST /api/procurement/deal/:dealId/ship-close { ttn:[{filename,base64,mime}] } — зафиксировать «всё отправлено»
router.post('/deal/:dealId/ship-close', requireAuth(ROLES), express.json({ limit: '45mb' }), async (req, res) => {
  try {
    const { closeDealShipment } = require('../procurement-calc');
    const ttn = (req.body || {}).ttn || [];
    res.json(await closeDealShipment(parseInt(req.params.dealId, 10), Array.isArray(ttn) ? ttn : [ttn], req.user.bitrix_user_id || null));
  } catch (e) {
    res.status(e.userFacing ? 400 : 500).json({ error: e.message });
  }
});

// POST /api/procurement/deal/:dealId/ship-open — снять фиксацию (открыть заново)
router.post('/deal/:dealId/ship-open', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { reopenDealShipment } = require('../procurement-calc');
    res.json(await reopenDealShipment(parseInt(req.params.dealId, 10)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/procurement/deal/:dealId/ship-file { itemId?, filename, base64, mime } — добавить ТТН (доотправка/основная)
router.post('/deal/:dealId/ship-file', requireAuth(ROLES), express.json({ limit: '45mb' }), async (req, res) => {
  try {
    const { addShipFile } = require('../procurement-calc');
    const { itemId, filename, base64, mime } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'Нужен base64' });
    res.json(await addShipFile(parseInt(req.params.dealId, 10), itemId || null, { filename, base64, mime }, req.user.bitrix_user_id || null));
  } catch (e) { res.status(e.userFacing ? 400 : 500).json({ error: e.message }); }
});

// GET /api/procurement/deal/:dealId/ship-file/:fileId/download — скачать ТТН
router.get('/deal/:dealId/ship-file/:fileId/download', requireAuth(ROLES), async (req, res) => {
  try {
    const { getShipFileBytes } = require('../procurement-calc');
    const f = await getShipFileBytes(parseInt(req.params.dealId, 10), parseInt(req.params.fileId, 10));
    if (!f) return res.status(404).send('Файл не найден');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    res.send(f.buffer);
  } catch (e) { res.status(500).send('Ошибка'); }
});

// DELETE /api/procurement/deal/:dealId/ship-file/:fileId — удалить ТТН
router.delete('/deal/:dealId/ship-file/:fileId', requireAuth(ROLES), async (req, res) => {
  try {
    const { removeShipFile } = require('../procurement-calc');
    res.json(await removeShipFile(parseInt(req.params.dealId, 10), parseInt(req.params.fileId, 10)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/procurement/:id/fully-received { value } — отметка «Полностью принят»
router.post('/:id/fully-received', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { setFullyReceived } = require('../procurement-calc');
    res.json(await setFullyReceived(parseInt(req.params.id, 10), !!(req.body || {}).value, req.user.bitrix_user_id || null));
  } catch (e) {
    console.error('POST /api/procurement/:id/fully-received error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
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

// DELETE /api/procurement/:id — удалить заявку и элемент 1066.
// Удаление в «Закупках» разрешено ТОЛЬКО роли admin (PROC не входит в модули
// удаления менеджера/логиста/координатора). Всегда пишем в аудит.
router.delete('/:id', requireAuth(DEL_ROLES), async (req, res) => {
  try {
    const { canDelete, auditLog } = require('../auth');
    if (!canDelete(req.user, 'PROC')) return res.status(403).json({ error: 'Удаление закупок доступно только администратору.' });
    const { deleteRequest } = require('../procurement-calc');
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) return res.status(400).json({ error: 'Укажите причину удаления.' });
    const out = await deleteRequest(parseInt(req.params.id, 10), req.user.bitrix_user_id || null, reason);
    auditLog(req.user.id, req.user.username, 'PROCUREMENT_DELETED', String(req.params.id), { reason }, req.ip, req.headers['user-agent']).catch(() => {});
    return res.json(out);
  } catch (e) {
    console.error('DELETE /api/procurement/:id error:', e.message);
    res.status(500).json({ error: 'Не удалось удалить: ' + e.message });
  }
});

// GET /api/procurement/:id/detail — документы + согласование (из 1066)
router.get('/:id/detail', requireAuth(VIEW_ROLES), async (req, res) => {
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

// POST /api/procurement/:id/amount { opportunity, currency } — сумма закупки (2 этап)
router.post('/:id/amount', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { setAmount } = require('../procurement-calc');
    const { opportunity, currency } = req.body || {};
    if (!(Number(opportunity) > 0)) return res.status(400).json({ error: 'Укажите сумму закупки больше 0' });
    res.json(await setAmount(parseInt(req.params.id, 10), opportunity, currency));
  } catch (e) {
    console.error('POST /api/procurement/:id/amount error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить сумму: ' + e.message });
  }
});

// POST /api/procurement/:id/poa-setup { required, accountantBid } — доверенность (2 этап)
router.post('/:id/poa-setup', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { setPoaSetup } = require('../procurement-calc');
    const { required, accountantBid } = req.body || {};
    res.json(await setPoaSetup(parseInt(req.params.id, 10), !!required, accountantBid));
  } catch (e) {
    console.error('POST /api/procurement/:id/poa-setup error:', e.message);
    res.status(e.userFacing ? 400 : 500).json({ error: e.message });
  }
});

// POST /api/procurement/:id/request-approval { approverId } — отправить на согласование
router.post('/:id/request-approval', requireAuth(ROLES), express.json(), async (req, res) => {
  try {
    const { requestApproval } = require('../procurement-calc');
    const b = req.body || {};
    const approvers = b.approverIds != null ? b.approverIds : b.approverId;
    res.json(await requestApproval(parseInt(req.params.id, 10), approvers, b.note));
  } catch (e) {
    console.error('POST /api/procurement/:id/request-approval error:', e.message);
    res.status(500).json({ error: 'Не удалось отправить на согласование: ' + e.message });
  }
});

// POST /api/procurement/:id/approval { status, approverId, comment } — решение по согласованию
router.post('/:id/approval', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { setApproval, getItemDetail } = require('../procurement-calc');
    const localId = parseInt(req.params.id, 10);
    let { status, approverId, comment } = req.body || {};
    // engineer/sales и бухгалтер решают ТОЛЬКО от своего имени и только если он
    // в списке согласующих этой закупки.
    if (OWN_ONLY.includes(req.user.role)) {
      const bid = String(req.user.bitrix_user_id || '');
      approverId = bid;
      const det = await getItemDetail(localId).catch(() => null);
      const list = (det && det.approval && det.approval.approvers || []).map(a => String(a.bid));
      if (!bid || !list.includes(bid)) return res.status(403).json({ error: 'Вы не назначены согласующим по этой закупке' });
    }
    res.json(await setApproval(localId, status, approverId, comment));
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

// GET /api/procurement/pending-count — число действий, за которые отвечает
// текущий пользователь (для бейджа на иконке установленного приложения).
router.get('/pending-count', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { pendingActionsFor } = require('../procurement-calc');
    const bid = req.user && req.user.bitrix_user_id;
    if (!bid) return res.json({ count: 0, items: [] });
    res.set('Cache-Control', 'no-store');
    res.json(await pendingActionsFor(bid));
  } catch (e) {
    console.error('GET /api/procurement/pending-count error:', e.message);
    res.status(500).json({ count: 0, items: [], error: e.message });
  }
});

module.exports = { router };

// ─────────────────────────────────────────────────────────────────────────────
// Модуль «КАМ» (ключевые клиенты). Иерархия:
//   Группа компаний → Компания → [Отдел/Лаборатория/Факультет]? → КАМ → Проекты → сделки
// Слой подразделения опциональный (нет слоя → проекты сразу под компанией).
// КАМ назначается гибко на любом уровне, наследуется вниз, переопределяется.
// Реестр подразделений ведём в ЦУП (зависимость «компания → её подразделения»),
// значение пишем в текстовое поле сделки Битрикса; всё зеркалится в Б24.
//
// Статус: сборка. Этот файл стартует с диагностики полей (field-probe), затем
// обрастёт чтением дерева/портфеля и админкой с записью в Битрикс.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { b24 } = require('../bitrix');
const { memo } = require('../cache');
const kam = require('../kam-calc');

const ADMIN_ROLES = ['admin', 'superadmin', 'coordinator'];
const VIEW_ROLES = ['admin', 'superadmin', 'coordinator', 'manager', 'sales', 'sales_head'];

// GET /api/kam/field-probe — найти коды полей сделки по названию (разовая разведка).
// Нужно подтвердить: «Группа компаний (УС)», «Название отдела/лаборатории/факультета»,
// КАМ, «В рамках проекта». Убрать после фиксации кодов в kam-calc.
router.get('/field-probe', requireAuth(ADMIN_ROLES), async (req, res) => {
  try {
    const { result } = await b24('crm.deal.fields', {});
    const rx = /групп|отдел|лаборатор|факультет|\bкам\b|key ?account|рамк|проект|конечн/i;
    const KNOWN = /1731862481|1791972186|1731862784|1731862784/;
    const out = {};
    for (const [code, f] of Object.entries(result || {})) {
      const title = f.formLabel || f.title || f.listLabel || f.filterLabel || '';
      if (rx.test(title) || KNOWN.test(code)) {
        out[code] = {
          title,
          type: f.type,
          isList: !!(f.items && f.items.length),
          isMultiple: !!f.isMultiple,
          items: (f.items || []).slice(0, 12).map(i => ({ id: i.ID, v: i.VALUE })),
        };
      }
    }
    res.json({ count: Object.keys(out).length, fields: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── READ: дерево / узел / портфель КАМ / подразделения ───────────────────────
router.get('/tree', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const full = ADMIN_ROLES.includes(req.user.role);
    const userBid = req.user.bitrix_user_id ? parseInt(req.user.bitrix_user_id, 10) : null;
    const key = full ? 'kam:tree:full' : ('kam:tree:u' + userBid);
    res.json(await memo(key, 120 * 1000, () => kam.getTree({ full, userBid })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/project-tree', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const full = ADMIN_ROLES.includes(req.user.role);
    const userBid = req.user.bitrix_user_id ? parseInt(req.user.bitrix_user_id, 10) : null;
    const key = full ? 'kam:ptree:full' : ('kam:ptree:u' + userBid);
    res.json(await memo(key, 120 * 1000, () => kam.getProjectTree({ full, userBid })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/node/:type/:key', requireAuth(VIEW_ROLES), async (req, res) => {
  try { res.json(await kam.getNode(req.params.type, decodeURIComponent(req.params.key))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/kam/:bid', requireAuth(VIEW_ROLES), async (req, res) => {
  try { res.json(await kam.getKamPortfolio(req.params.bid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/units', requireAuth(VIEW_ROLES), async (req, res) => {
  try { res.json(await kam.listUnits(req.query.company || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/project-options', requireAuth(VIEW_ROLES), async (req, res) => {
  try { res.json({ options: await kam.listProjectOptions() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Аналитика КАМ (вкладка «Аналитика»): скоуп как у дерева (админ — всё, КАМ — свои).
router.get('/analytics', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const full = ADMIN_ROLES.includes(req.user.role);
    const userBid = req.user.bitrix_user_id ? parseInt(req.user.bitrix_user_id, 10) : null;
    const key = full ? 'kam:analytics:full' : ('kam:analytics:u' + userBid);
    res.json(await memo(key, 120 * 1000, () => kam.getAnalytics({ full, userBid })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Глубокая детализация компании по стадиям (п.8).
router.get('/company-stages', requireAuth(VIEW_ROLES), async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(await kam.getCompanyStages(req.query.company || '')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/deals', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    if (req.query.type) return res.json(await kam.nodeDeals(req.query.type, decodeURIComponent(req.query.key || ''), req.query.project ? decodeURIComponent(req.query.project) : ''));
    res.json(await kam.listDeals(req.query.company || '', req.query.unit || ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── АДМИНКА (запись) ─────────────────────────────────────────────────────────
router.get('/users', requireAuth(ADMIN_ROLES), async (req, res) => {
  try { res.json({ users: await kam.listUsers() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/groups', requireAuth(ADMIN_ROLES), async (req, res) => {
  try { res.json({ groups: await kam.listGroups() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/assign-kam', requireAuth(ADMIN_ROLES), express.json(), async (req, res) => {
  try { const { level, key, kamBid } = req.body || {}; res.json(await kam.assignKam(level, key, kamBid === '' ? null : kamBid, req.user && req.user.username)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Создать подразделение: админ/координатор — любой компании; назначенный КАМ — своей.
router.post('/unit', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { companyId, name, kind } = req.body || {};
    if (!(await kam.canManageCompany(req.user.bitrix_user_id, req.user.role, companyId)))
      return res.status(403).json({ error: 'Подразделения можно заводить только своим компаниям (где вы назначены КАМ)' });
    res.json(await kam.createUnit(companyId, name, kind, req.user && req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Создать проект (enum «В рамках проекта») в Битриксе; при наличии dealId — сразу назначить.
router.post('/project-create', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { companyId, name, dealId } = req.body || {};
    if (!(await kam.canManageCompany(req.user.bitrix_user_id, req.user.role, companyId)))
      return res.status(403).json({ error: 'Проекты можно создавать только своим компаниям (где вы назначены КАМ)' });
    const created = await kam.createProject(name, req.user && req.user.username);
    if (dealId && created.id) { try { await kam.setDealProject(dealId, created.id, req.user && req.user.username); } catch (e) { /* назначит пользователь из списка */ } }
    res.json(created);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/unit/:id', requireAuth(ADMIN_ROLES), async (req, res) => {
  try { res.json(await kam.deleteUnit(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/move-company', requireAuth(ADMIN_ROLES), express.json(), async (req, res) => {
  try { const { companyId, companyName, group } = req.body || {}; res.json(await kam.moveCompanyGroup(companyId, companyName, group, req.user && req.user.username)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Назначить подразделение/проект сделке: админ/координатор — любой; назначенный КАМ — своей компании.
router.post('/deal-unit', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { dealId, unit } = req.body || {};
    const cid = await kam.dealCompanyId(dealId);
    if (!(await kam.canManageCompany(req.user.bitrix_user_id, req.user.role, cid)))
      return res.status(403).json({ error: 'Менять можно только сделки своих компаний (где вы назначены КАМ)' });
    res.json(await kam.setDealUnit(dealId, unit, req.user && req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/deal-project', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { dealId, projectId } = req.body || {};
    const cid = await kam.dealCompanyId(dealId);
    if (!(await kam.canManageCompany(req.user.bitrix_user_id, req.user.role, cid)))
      return res.status(403).json({ error: 'Менять можно только сделки своих компаний (где вы назначены КАМ)' });
    res.json(await kam.setDealProject(dealId, projectId, req.user && req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Планируемый срок покупки (п.6) ───────────────────────────────────────────
// По одной сделке: админ/координатор любой, КАМ — своей компании.
router.post('/deal-planned', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { dealId, date } = req.body || {};
    const cid = await kam.dealCompanyId(dealId);
    if (!(await kam.canManageCompany(req.user.bitrix_user_id, req.user.role, cid)))
      return res.status(403).json({ error: 'Менять можно только сделки своих компаний (где вы назначены КАМ)' });
    res.json(await kam.setDealPlanned(dealId, date, req.user && req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// На весь проект: проставится во все сделки проекта, которые пользователь вправе менять.
router.post('/project-planned', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { project, date } = req.body || {};
    res.json(await kam.setProjectPlanned(project, date, req.user.bitrix_user_id, req.user.role, req.user && req.user.username));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Комментарии (п.5): таймлайн Битрикса, как в «План продаж» ────────────────
// Лента комментариев сделки.
router.get('/deal/:id/comments', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { USERS } = require('../constants');
    const id = parseInt(req.params.id, 10);
    const { result } = await b24('crm.timeline.comment.list', { filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' }, order: { CREATED: 'DESC' } });
    const items = (result || []).map(c => ({ id: c.ID, text: c.COMMENT || '', author: c.AUTHOR_ID ? (USERS[c.AUTHOR_ID] || ('#' + c.AUTHOR_ID)) : '—', created: c.CREATED || null }));
    res.set('Cache-Control', 'no-store'); res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ error: e.message, items: [] }); }
});
// Добавить комментарий к сделке (в таймлайн Битрикса).
router.post('/deal/:id/comments', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
    const cid = await kam.dealCompanyId(id);
    if (!(await kam.canManageCompany(req.user.bitrix_user_id, req.user.role, cid)))
      return res.status(403).json({ error: 'Комментировать можно только сделки своих компаний (где вы назначены КАМ)' });
    const bid = req.user.bitrix_user_id ? parseInt(req.user.bitrix_user_id, 10) : null;
    const fields = { ENTITY_ID: id, ENTITY_TYPE: 'deal' };
    if (bid) { fields.AUTHOR_ID = bid; fields.COMMENT = text; }
    else { const who = (req.user && (req.user.display_name || req.user.engineer_name)) || 'сотрудник ЦУП'; fields.COMMENT = `[${who}]: ${text}`; }
    const { result } = await b24('crm.timeline.comment.add', { fields });
    res.json({ ok: true, id: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Комментарий на весь проект → во все его сделки (которые пользователь вправе менять).
router.post('/project-comment', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { project, text } = req.body || {};
    res.json(await kam.addProjectComment(project, text, req.user));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ручной полный пересинк зеркала из Битрикса (п.7) ─────────────────────────
// Переподтягивает все сделки (fullSync из stats-sync, общий с «Статистикой»/«План продаж»).
// Фон; прогресс — в /resync-status. Тяжёлая операция → только админ/координатор.
let _kamResyncBusy = false;
router.post('/resync', requireAuth(ADMIN_ROLES), async (req, res) => {
  if (_kamResyncBusy) return res.json({ ok: true, started: false, busy: true });
  _kamResyncBusy = true;
  res.json({ ok: true, started: true });
  (async () => {
    try { const { fullSync } = require('../stats-sync'); await fullSync(); }
    catch (e) { console.error('kam resync error:', e.message); }
    finally { _kamResyncBusy = false; }
  })();
});
router.get('/resync-status', requireAuth(ADMIN_ROLES), (req, res) => {
  try { res.json({ ok: true, busy: _kamResyncBusy, progress: require('../stats-sync').getSyncProgress() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

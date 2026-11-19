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
router.post('/unit', requireAuth(ADMIN_ROLES), express.json(), async (req, res) => {
  try { const { companyId, name, kind } = req.body || {}; res.json(await kam.createUnit(companyId, name, kind, req.user && req.user.username)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/unit/:id', requireAuth(ADMIN_ROLES), async (req, res) => {
  try { res.json(await kam.deleteUnit(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/move-company', requireAuth(ADMIN_ROLES), express.json(), async (req, res) => {
  try { const { companyId, companyName, group } = req.body || {}; res.json(await kam.moveCompanyGroup(companyId, companyName, group, req.user && req.user.username)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/deal-unit', requireAuth(ADMIN_ROLES), express.json(), async (req, res) => {
  try { const { dealId, unit } = req.body || {}; res.json(await kam.setDealUnit(dealId, unit, req.user && req.user.username)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/deal-project', requireAuth(ADMIN_ROLES), express.json(), async (req, res) => {
  try { const { dealId, projectId } = req.body || {}; res.json(await kam.setDealProject(dealId, projectId, req.user && req.user.username)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

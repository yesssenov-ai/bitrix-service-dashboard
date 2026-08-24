const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator', 'manager', 'store', 'accountant'];
const EDIT_ROLES = ['admin', 'coordinator'];   // кто назначает БДМ / группу клиенту

// GET /api/projects — дерево «Группа → Клиент → БДМ → Проект → продакт-сделки» + аудит.
router.get('/', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getProjects } = require('../projects-calc');
    res.set('Cache-Control', 'no-store');
    res.json(await getProjects());
  } catch (e) {
    console.error('GET /api/projects error:', e.message);
    res.status(500).json({ error: e.message, groupsTree: [], audit: {}, meta: {} });
  }
});

// GET /api/projects/clients — справочник клиентов (компании + текущее назначение БДМ/группы).
router.get('/clients', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getClientsDirectory } = require('../projects-calc');
    res.set('Cache-Control', 'no-store');
    res.json({ items: await getClientsDirectory() });
  } catch (e) {
    console.error('GET /api/projects/clients error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// POST /api/projects/client { companyId, companyName, bdmId, group } — назначить БДМ/группу.
router.post('/client', requireAuth(EDIT_ROLES), express.json(), async (req, res) => {
  try {
    const { setClient } = require('../projects-calc');
    const b = req.body || {};
    if (!b.companyId) return res.status(400).json({ error: 'Не указан клиент' });
    await setClient(b.companyId, b.companyName, b.bdmId || null, b.group || null,
      (req.user && (req.user.display_name || req.user.username)) || null);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/projects/client error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

// POST /api/projects/resync — полная пересинхронизация зеркала (админ), чтобы у сделок
// заполнились новые поля (тип КП, комплексная, родительская, группа). Фон.
let _busy = false;
router.post('/resync', requireAuth(['admin']), async (req, res) => {
  if (_busy) return res.json({ ok: true, started: false, busy: true });
  _busy = true;
  res.json({ ok: true, started: true });
  (async () => {
    try { const { fullSync } = require('../stats-sync'); await fullSync(); }
    catch (e) { console.error('projects resync error:', e.message); }
    finally { _busy = false; }
  })();
});

module.exports = { router };

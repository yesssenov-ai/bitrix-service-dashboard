const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'superadmin', 'coordinator', 'manager', 'store', 'accountant'];
const EDIT_ROLES = ['admin', 'superadmin', 'coordinator'];   // кто назначает КАМ на проект

// GET /api/projects — проекты (по полю «В рамках проекта») + вид по компаниям + аудит.
router.get('/', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getProjects } = require('../projects-calc');
    res.set('Cache-Control', 'no-store');
    res.json(await getProjects());
  } catch (e) {
    console.error('GET /api/projects error:', e.message);
    res.status(500).json({ error: e.message, projects: [], companies: [], audit: {}, meta: {} });
  }
});

// POST /api/projects/kam { project, kamId } — назначить/снять КАМ на проект.
router.post('/kam', requireAuth(EDIT_ROLES), express.json(), async (req, res) => {
  try {
    const { setProjectKam } = require('../projects-calc');
    const b = req.body || {};
    if (!b.project) return res.status(400).json({ error: 'Не указан проект' });
    await setProjectKam(b.project, b.kamId || null,
      (req.user && (req.user.display_name || req.user.username)) || null);
    res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/projects/kam error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

// POST /api/projects/resync — полная пересинхронизация зеркала (админ), чтобы у сделок
// заполнилось поле «В рамках проекта». Фон.
let _busy = false;
router.post('/resync', requireAuth(['admin', 'superadmin']), async (req, res) => {
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

// Модуль «Компании / Оздоровление» (Фаза 1). Страница под грантом CMP; чтение —
// любой авторизованный с грантом; правка (запись в Б24) — admin/coordinator.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const EDIT = ['admin', 'coordinator'];

// Доска компаний (список + справочник сфер + сводка проблем)
router.get('/', requireAuth([]), async (req, res) => {
  try { res.json(await require('../companies-calc').getCompaniesBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Пересинхронизировать компании из Б24
router.post('/refresh', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').syncCompanies()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Правка компании (сфера / название) → запись в Б24 + зеркало
router.post('/:id', requireAuth(EDIT), express.json(), async (req, res) => {
  try {
    const { industryId, title } = req.body || {};
    res.json(await require('../companies-calc').updateCompany(req.params.id, { industryId, title }));
  } catch (e) {
    console.error('POST /api/companies/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };

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

// Группы-кандидаты на дубль (Фаза 2 — только обнаружение)
router.get('/duplicates', requireAuth([]), async (req, res) => {
  try { res.json(await require('../companies-calc').getDuplicateGroups()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Журнал слияний (Фаза 3)
router.get('/merges', requireAuth([]), async (req, res) => {
  try { res.json(await require('../companies-calc').listMerges(req.query.limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Диагностика записи в Б24: GET /api/companies/selftest?id=123
router.get('/selftest', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').writeSelfTest(req.query.id, { keep: req.query.keep === '1' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Диагностика: реквизит компании (коды полей RQ_* для переименования)
router.get('/:id/requisite', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').companyRequisite(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Сделки компании (провалиться в сделки из ЦУП)
router.get('/:id/deals', requireAuth([]), async (req, res) => {
  try { res.json(await require('../companies-calc').getCompanyDeals(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Пересинхронизировать компании из Б24
router.post('/refresh', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').syncCompanies()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Слияние: предпросмотр → применение → откат (Фаза 3). Запись в Б24 — только EDIT.
router.post('/merge/preview', requireAuth(EDIT), express.json(), async (req, res) => {
  try {
    const { canonicalId, duplicateIds } = req.body || {};
    res.json(await require('../companies-calc').previewMerge(canonicalId, duplicateIds));
  } catch (e) { console.error('merge/preview:', e.message); res.status(500).json({ error: e.message }); }
});
router.post('/merge/apply', requireAuth(EDIT), express.json(), async (req, res) => {
  try {
    const { canonicalId, duplicateIds, copyFields } = req.body || {};
    const byUser = (req.user && (req.user.display_name || req.user.username)) || '';
    res.json(await require('../companies-calc').applyMerge({ canonicalId, duplicateIds, copyFields: copyFields !== false, byUser }));
  } catch (e) { console.error('merge/apply:', e.message); res.status(500).json({ error: e.message }); }
});
router.post('/merge/undo', requireAuth(EDIT), express.json(), async (req, res) => {
  try {
    const byUser = (req.user && (req.user.display_name || req.user.username)) || '';
    res.json(await require('../companies-calc').undoMerge(req.body && req.body.mergeId, byUser));
  } catch (e) { console.error('merge/undo:', e.message); res.status(500).json({ error: e.message }); }
});

// Удаление компании из Б24 (необратимо; отказ при наличии привязанных объектов)
router.post('/:id/delete', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').deleteCompany(req.params.id)); }
  catch (e) { console.error('company delete:', e.message); res.status(500).json({ error: e.message }); }
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

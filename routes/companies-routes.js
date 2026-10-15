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

// Карта «название компании → страна» для флагов в других модулях (любой авторизованный).
router.get('/country-map', requireAuth([]), async (req, res) => {
  try { res.set('Cache-Control', 'private, max-age=300'); res.json(await require('../companies-calc').countryMap()); }
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

// Предпросмотр заполнения БИН (старое→новое). Ничего не пишет.
router.get('/bin-preview', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').previewBin(req.query.id, req.query.bin)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Запись подтверждённого БИН в карточку Б24 (компания + реквизит). Перезаписывает поля.
router.post('/bin-apply', requireAuth(EDIT), express.json(), async (req, res) => {
  try { const { id, bin } = req.body || {}; res.json(await require('../companies-calc').applyBin(id, bin)); }
  catch (e) { console.error('bin-apply:', e.message); res.status(500).json({ error: e.message }); }
});

// Диагностика переименования: поле короткого имени (источник БП), TITLE,
// заполненные UF-поля и реквизит — чтобы сверить, откуда БП берёт Название.
router.get('/:id/requisite', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').renameDiag(req.params.id)); }
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
// Массовый откат: без тела — все неоткатанные; { ids:[...] } — выбранные.
router.post('/merge/undo-all', requireAuth(EDIT), express.json(), async (req, res) => {
  try {
    const byUser = (req.user && (req.user.display_name || req.user.username)) || '';
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    res.json(await require('../companies-calc').undoAllMerges(byUser, ids));
  } catch (e) { console.error('merge/undo-all:', e.message); res.status(500).json({ error: e.message }); }
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

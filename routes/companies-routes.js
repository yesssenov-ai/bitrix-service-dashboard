// Модуль «Компании / Оздоровление» (Фаза 1). Страница под грантом CMP; чтение —
// любой авторизованный с грантом; правка (запись в Б24) — admin/coordinator.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const { memo, bust } = require('../cache');

const EDIT = ['admin']; // правка «Компаний» — только админам (superadmin наследует)

// Доска компаний (список + справочник сфер + сводка проблем). Кэш 2 мин на всех —
// большая выборка, читается всеми одинаково; сбрасывается после правки/синка.
router.get('/', requireAuth([]), async (req, res) => {
  try { res.json(await memo('cmp:board', 120 * 1000, () => require('../companies-calc').getCompaniesBoard())); }
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

// Диагностика источника БИН: какие поля похожи на «БИН/ИИН» и сколько заполнено
// на сэмпле компаний. Ничего не пишет. /api/companies/bin-debug?limit=800
router.get('/bin-debug', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').binDebug(req.query.limit)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Перенос сферы: старое поле INDUSTRY → новое поле-список.
// Предпросмотр (ничего не пишет): /api/companies/industry-migrate-preview
router.get('/industry-migrate-preview', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../companies-calc').industryMigratePreview()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Запуск переноса (ПИШЕТ в Б24). Требует явного подтверждения.
// Из браузера: /api/companies/industry-migrate-apply?confirm=yes
function _startMigrate(req, res) {
  try {
    const ok = (req.query && req.query.confirm === 'yes') || (req.body && req.body.confirm === true);
    if (!ok) return res.status(400).json({ error: 'Нужно подтверждение: ?confirm=yes' });
    const st = require('../companies-calc').startIndustryMigration();
    bust('cmp:board');
    res.json({ started: true, status: st });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
router.get('/industry-migrate-apply', requireAuth(EDIT), _startMigrate);
router.post('/industry-migrate-apply', requireAuth(EDIT), express.json(), _startMigrate);
// Статус фонового переноса: /api/companies/industry-migrate-status
router.get('/industry-migrate-status', requireAuth(EDIT), async (req, res) => {
  try { res.json(require('../companies-calc').industryMigrationStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Запись подтверждённого БИН в карточку Б24 (компания + реквизит). Перезаписывает поля.
router.post('/bin-apply', requireAuth(EDIT), express.json(), async (req, res) => {
  try { const { id, bin } = req.body || {}; const r = await require('../companies-calc').applyBin(id, bin); bust('cmp:board'); res.json(r); }
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
  try { const r = await require('../companies-calc').syncCompanies(); bust('cmp:board'); res.json(r); }
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

// Массовое удаление (необратимо; компании с привязанными объектами пропускаются).
// ВАЖНО: объявлено ДО '/:id/delete' и '/:id', иначе express примет 'bulk-delete'
// за :id. Тело: { ids:[...] }.
router.post('/bulk-delete', requireAuth(EDIT), express.json(), async (req, res) => {
  try { res.json(await require('../companies-calc').bulkDeleteCompanies(req.body && req.body.ids)); }
  catch (e) { console.error('companies bulk-delete:', e.message); res.status(500).json({ error: e.message }); }
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
    const r = await require('../companies-calc').updateCompany(req.params.id, { industryId, title });
    bust('cmp:board');
    res.json(r);
  } catch (e) {
    console.error('POST /api/companies/:id error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };

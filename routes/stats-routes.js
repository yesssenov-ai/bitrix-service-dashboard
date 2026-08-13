const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const PM_ROLES = ['admin', 'coordinator'];

function yearRange(year) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// GET /api/stats/board?year=2026 — единый борд новой Статистики (все вкладки).
// Кэш в процессе на 10 мин по году; ?force=1 пересчитывает.
const _boardCache = new Map();
router.get('/board', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const force = req.query.force === '1';
    const cached = _boardCache.get(year);
    if (cached && !force && Date.now() - cached.at < 10 * 60 * 1000) return res.json(cached.data);
    const { computeBoard } = require('../stats2-calc');
    const data = await computeBoard(year);
    _boardCache.set(year, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('GET /api/stats/board error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/stats/conversions?year=2026 — Фаза 2: реальные конверсии и тайминги
// (кэш 10 мин по году, ?force=1 пересчитывает).
const _convCache = new Map();
router.get('/conversions', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const force = req.query.force === '1';
    const cached = _convCache.get(year);
    if (cached && !force && Date.now() - cached.at < 10 * 60 * 1000) return res.json(cached.data);
    const { computeConversions } = require('../stats2-calc');
    const data = await computeConversions(year);
    _convCache.set(year, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('GET /api/stats/conversions error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать конверсии: ' + e.message });
  }
});

// POST /api/stats/backfill-history — одноразовый (можно повторно) сбор истории
// стадий из Битрикс в фоне сервера. Идёт ~несколько минут, прогресс — в
// /backfill-status и в логах Railway.
let historyBackfillRunning = false;
router.post('/backfill-history', requireAuth(['admin']), async (req, res) => {
  const { backfillStageHistory, status } = require('../stagehistory-sync');
  if (status().running) return res.json({ ok: true, started: false, note: 'Сбор истории уже идёт' });
  historyBackfillRunning = true;
  backfillStageHistory()
    .then(n => console.log(`✅ stage-history backfill (эндпоинт) завершён: ${n} записей`))
    .catch(e => console.error('stage-history backfill error:', e.message))
    .finally(() => { historyBackfillRunning = false; });
  res.json({ ok: true, started: true, note: 'Сбор истории стадий запущен в фоне — прогресс в статусе и логах Railway' });
});

// GET /api/stats/backfill-status — прогресс сбора истории.
router.get('/backfill-status', requireAuth(PM_ROLES), (req, res) => {
  const { status } = require('../stagehistory-sync');
  res.json({ ok: true, ...status() });
});

// GET /api/stats/summary?year=2026
router.get('/summary', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { start, end } = yearRange(year);
    const { getWonDealsInRange, summarizeByManufacturerAndType } = require('../stats-calc');
    const deals = await getWonDealsInRange(start, end);
    const summary = summarizeByManufacturerAndType(deals);
    res.json({ year, dealCount: deals.length, ...summary });
  } catch (e) {
    console.error('GET /api/stats/summary error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/stats/managers?year=2026
router.get('/managers', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { start, end } = yearRange(year);
    const { getWonDealsInRange, summarizeByManager } = require('../stats-calc');
    const deals = await getWonDealsInRange(start, end);
    res.json({ year, managers: summarizeByManager(deals) });
  } catch (e) {
    console.error('GET /api/stats/managers error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/stats/instruments?year=2026
router.get('/instruments', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { start, end } = yearRange(year);
    const { getWonDealsInRange, summarizeByInstrument } = require('../stats-calc');
    const deals = await getWonDealsInRange(start, end);
    res.json({ year, instruments: summarizeByInstrument(deals) });
  } catch (e) {
    console.error('GET /api/stats/instruments error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// POST /api/stats/resync — запускает полный пересинк В СЕРВЕРНОМ ПРОЦЕССЕ
// (не в консоли — потому переживает отключение консоли/сессии). Fire-and-forget:
// сразу возвращает started:true, а синк крутится в фоне до конца. Прогресс —
// в логах деплоя Railway (Deployments → Logs), там же финальное «✅ Синхронизировано».
let statsResyncRunning = false;
router.post('/resync', requireAuth(['admin']), async (req, res) => {
  if (statsResyncRunning) return res.json({ ok: true, started: false, note: 'Пересинк уже идёт' });
  statsResyncRunning = true;
  const { fullSync } = require('../stats-sync');
  fullSync()
    .then(n => console.log(`✅ stats resync (эндпоинт) завершён: ${n} сделок`))
    .catch(e => console.error('stats resync error:', e.message))
    .finally(() => { statsResyncRunning = false; });
  res.json({ ok: true, started: true, note: 'Пересинк запущен в фоне сервера — прогресс в логах деплоя Railway' });
});

// GET /api/stats/resync-status — идёт ли пересинк прямо сейчас.
router.get('/resync-status', requireAuth(['admin']), (req, res) => res.json({ ok: true, running: statsResyncRunning }));

module.exports = { router };

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

// Доступ к данным статистики: admin/coordinator/manager. Кому реально видно
// модуль — решает «Доступ к модулям» (гейт страницы requireModule('STATS'));
// здесь лишь ролевой предел на сами данные/действия. Тяжёлые операции
// (resync/backfill истории) остаются только у admin.
const PM_ROLES = ['admin', 'coordinator', 'manager'];

function yearRange(year) {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

// Разбор списка лет из query: ?years=2025,2026 (или один ?year=2026).
function parseYears(req) {
  const raw = (req.query.years != null && req.query.years !== '') ? req.query.years : req.query.year;
  const arr = String(raw || '').split(',').map(s => parseInt(s, 10)).filter(Boolean);
  return arr.length ? [...new Set(arr)].sort((a, b) => a - b) : [new Date().getFullYear()];
}

// GET /api/stats/board?years=2025,2026 — единый борд новой Статистики (все вкладки).
// Мультивыбор лет: данные суммируются. Кэш в процессе на 10 мин по набору лет.
const _boardCache = new Map();
router.get('/board', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const years = parseYears(req);
    const key = years.join(',');
    const force = req.query.force === '1';
    const cached = _boardCache.get(key);
    if (cached && !force && Date.now() - cached.at < 10 * 60 * 1000) return res.json(cached.data);
    const { computeBoard } = require('../stats2-calc');
    const data = await computeBoard(years);
    _boardCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (e) {
    console.error('GET /api/stats/board error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/stats/sphere-export?years=2025,2026[&sphere=Название] — xlsx-выгрузка
// по сферам: свод, свод по компаниям (широкий) и детализация сделок
// (подписанные по воронкам + в работе по воронкам и стадиям).
router.get('/sphere-export', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const years = parseYears(req);
    const sphere = (req.query.sphere && String(req.query.sphere).trim()) || null;
    const { buildSphereWorkbook } = require('../stats-export');
    const { buffer, years: sel } = await buildSphereWorkbook(years, sphere);
    const fname = `spheres_${sel.join('-')}${sphere ? '_' + sphere.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 30) : ''}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.end(buffer);
  } catch (e) {
    console.error('GET /api/stats/sphere-export error:', e.message);
    res.status(500).json({ error: 'Не удалось сформировать выгрузку: ' + e.message });
  }
});

// GET /api/stats/companies-export — пивот по компаниям (Тотал + годы × категории).
router.get('/companies-export', requireAuth(PM_ROLES), async (req, res) => {
  try {
    const { buildCompaniesPivotWorkbook } = require('../stats-export');
    const { buffer, fname } = await buildCompaniesPivotWorkbook();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.end(buffer);
  } catch (e) {
    console.error('GET /api/stats/companies-export error:', e.message);
    res.status(500).json({ error: 'Не удалось сформировать выгрузку: ' + e.message });
  }
});

// POST /api/stats/refresh — инкрементально подтянуть из Битрикса сделки,
// изменённые ПОСЛЕ последнего обновления зеркала (по DATE_MODIFY), а при ручном
// нажатии (reconcile:true) ещё и убрать удалённые. То же зеркало, что у Контрактов.
// Сбрасывает кэш борда/конверсий, чтобы след. запрос пересчитал свежие цифры.
let _statsRefreshing = false;
router.post('/refresh', requireAuth(PM_ROLES), express.json(), async (req, res) => {
  if (_statsRefreshing) return res.json({ ok: true, running: true, note: 'Обновление уже идёт' });
  _statsRefreshing = true;
  try {
    const { pool } = require('../auth');
    const { rows } = await pool.query('SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals');
    const last = rows[0] && rows[0].t ? new Date(rows[0].t).getTime() : null;
    const sinceMs = (last || (Date.now() - 7 * 86400 * 1000)) - 15 * 60 * 1000;
    const { incrementalSync, reconcileDeletions } = require('../stats-sync');
    const r = await incrementalSync(sinceMs);
    let deleted = 0;
    if (req.body && req.body.reconcile) {
      try { const rc = await reconcileDeletions(); deleted = rc.deleted || 0; }
      catch (e) { console.error('reconcileDeletions в /stats/refresh:', e.message); }
    }
    _boardCache.clear();
    _convCache.clear();
    const { rows: r2 } = await pool.query('SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals');
    res.json({ ok: true, updated: r.updated || 0, deleted, updatedAt: r2[0] && r2[0].t ? new Date(r2[0].t).toISOString() : null });
  } catch (e) {
    console.error('POST /api/stats/refresh error:', e.message);
    res.status(500).json({ error: 'Не удалось обновить: ' + e.message });
  } finally {
    _statsRefreshing = false;
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

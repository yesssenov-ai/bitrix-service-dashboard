const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator'];

// GET /api/contracts/summary?year=2026 — плоский список сделок + план + мета.
router.get('/summary', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const { getContractsSummary } = require('../contracts-calc');
    res.json(await getContractsSummary(year));
  } catch (e) {
    console.error('GET /api/contracts/summary error:', e.message);
    res.status(500).json({ error: 'Не удалось рассчитать: ' + e.message });
  }
});

// GET /api/contracts/news?mode=latest&limit=3 — самые свежие заключённые контракты;
// ?mode=window&days=3 — все заходы в «Контракт»/«Завершена» за N дней (по убыванию).
router.get('/news', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getRecentNews, getLatestContracts } = require('../contracts-calc');
    if (req.query.mode === 'window') {
      const days = Math.min(30, Math.max(1, parseInt(req.query.days, 10) || 3));
      return res.json({ mode: 'window', days, items: await getRecentNews(days) });
    }
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 3));
    res.json({ mode: 'latest', items: await getLatestContracts(limit) });
  } catch (e) {
    console.error('GET /api/contracts/news error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// POST /api/contracts/refresh — инкрементально подтянуть из Битрикса сделки,
// изменённые ПОСЛЕ последнего обновления зеркала (по DATE_MODIFY). Обновляет общее
// зеркало ticketsmodule_stat_deals (им же пользуется Статистика). Возвращает,
// сколько сделок обновлено и новую метку времени.
let _refreshing = false;
router.post('/refresh', requireAuth(VIEW_ROLES), async (req, res) => {
  if (_refreshing) return res.json({ ok: true, running: true, note: 'Обновление уже идёт' });
  _refreshing = true;
  try {
    const { pool } = require('../auth');
    const { rows } = await pool.query('SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals');
    const last = rows[0] && rows[0].t ? new Date(rows[0].t).getTime() : null;
    // Буфер 15 мин на рассинхрон часовых поясов/скос — повторный апсерт идемпотентен.
    const sinceMs = (last || (Date.now() - 7 * 86400 * 1000)) - 15 * 60 * 1000;
    const { incrementalSync } = require('../stats-sync');
    const r = await incrementalSync(sinceMs);
    const { rows: r2 } = await pool.query('SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals');
    res.json({ ok: true, updated: r.updated || 0, updatedAt: r2[0] && r2[0].t ? new Date(r2[0].t).toISOString() : null });
  } catch (e) {
    console.error('POST /api/contracts/refresh error:', e.message);
    res.status(500).json({ error: 'Не удалось обновить: ' + e.message });
  } finally {
    _refreshing = false;
  }
});

// POST /api/contracts/plan { year, department, amount } — правка плана (admin), ₸.
router.post('/plan', requireAuth(['admin']), express.json(), async (req, res) => {
  try {
    const year = parseInt(req.body.year, 10) || new Date().getFullYear();
    const department = String(req.body.department || '').trim();
    const amount = Number(req.body.amount);
    if (!department || !Number.isFinite(amount) || amount < 0) {
      return res.status(400).json({ error: 'Нужны department и неотрицательный amount (в ₸)' });
    }
    const { setPlan, getPlan } = require('../contracts-calc');
    await setPlan(year, department, amount);
    res.json({ ok: true, planMap: await getPlan(year) });
  } catch (e) {
    console.error('POST /api/contracts/plan error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить: ' + e.message });
  }
});

module.exports = { router };

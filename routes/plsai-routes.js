const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator', 'manager', 'store', 'accountant'];

// POST /api/plsai/query { q } — разобрать запрос и вернуть сводку + образец строк.
router.post('/query', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { analyze, runQuery, interpret, runAggregate, interpretAggregate } = require('../plsai-calc');
    const ops = require('../plsai-ops');
    const history = require('../plsai-history');
    const uid = req.user && req.user.id;
    const forecast = require('../plsai-forecast');
    const analytics = require('../plsai-analytics');
    const q = String((req.body || {}).q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });
    // Прогноз продаж на месяц.
    if (forecast.looksLikeForecast(q)) {
      const fc = await forecast.runForecast(q);
      history.save(uid, q, Object.assign({ type: 'forecast' }, fc));
      res.set('Cache-Control', 'no-store');
      return res.json(Object.assign({ ok: true, ai: true }, fc));
    }
    // Win-rate / конверсия по менеджерам и отделам.
    if (analytics.looksLikeWinrate(q)) {
      const w = await analytics.runWinrates(q);
      history.save(uid, q, Object.assign({ type: 'winrate' }, w));
      res.set('Cache-Control', 'no-store');
      return res.json(Object.assign({ ok: true, ai: true }, w));
    }
    // Sales Velocity (скорость продаж).
    if (analytics.looksLikeVelocity(q)) {
      const v = await analytics.runVelocity(q);
      history.save(uid, q, Object.assign({ type: 'velocity' }, v));
      res.set('Cache-Control', 'no-store');
      return res.json(Object.assign({ ok: true, ai: true }, v));
    }
    // Ветка «Реализация»: запросы по отгрузке от завода / поставке по договору и т.п.
    if (ops.looksLikeOps(q)) {
      const f = ops.parseOps(q);
      const { items, count, sumKzt } = await ops.runOps(f);
      history.save(uid, q, { type: 'ops', interpreted: ops.interpret(f), ops: true, dateLabel: f.field.label, count, sumKzt });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, interpreted: ops.interpret(f), ai: false, ops: true, dateLabel: f.field.label, count, sumKzt, sample: items.slice(0, 50) });
    }
    const a = await analyze(q);
    // Агрегация/рейтинг: «кто больше всех», «топ», «разбивка по…».
    if (a.aggregate) {
      if (a.needMetric) {
        res.set('Cache-Control', 'no-store');
        return res.json({ ok: true, ai: true, clarify: 'Считать по количеству или по сумме?', options: [{ label: '📊 По количеству', q: q + ' по количеству' }, { label: '💰 По сумме', q: q + ' по сумме' }] });
      }
      const agg = await runAggregate(a.f);
      const interpreted = interpretAggregate(a.f);
      history.save(uid, q, { type: 'aggregate', interpreted, aggregate: true, metric: agg.metric, rows: agg.rows.slice(0, 20), total: agg.total });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, ai: true, aggregate: true, interpreted, metric: agg.metric, groupBy: agg.groupBy, rows: agg.rows.slice(0, 20), total: agg.total });
    }
    // Ассистент ответил текстом (вопрос про систему/модули/статус, не выборка сделок).
    if (a.kind === 'assistant' && a.answer) {
      history.save(uid, q, { type: 'assistant', answer: a.answer, ai: true });
      res.set('Cache-Control', 'no-store'); return res.json({ ok: true, answer: a.answer, ai: true, kind: 'assistant' });
    }
    if (!a.f && a.clarify) {
      history.save(uid, q, { type: 'clarify', clarify: a.clarify, ai: true });
      res.set('Cache-Control', 'no-store'); return res.json({ ok: true, clarify: a.clarify, ai: true });
    }
    const { items, count, sumKzt } = await runQuery(a.f);
    history.save(uid, q, { type: 'deals', interpreted: interpret(a.f), ai: a.ai, note: a.clarify || null, count, sumKzt });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, interpreted: interpret(a.f), ai: a.ai, note: a.clarify || null, count, sumKzt, sample: items.slice(0, 50) });
  } catch (e) {
    console.error('POST /api/plsai/query error:', e.message);
    res.status(500).json({ error: 'Не удалось выполнить запрос: ' + e.message });
  }
});

// POST /api/plsai/export { q } — тот же запрос, но отдаём Excel-файл.
router.post('/export', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { parseQuery, analyze, runQuery, interpret, buildXlsx, runAggregate, interpretAggregate, buildAggXlsx } = require('../plsai-calc');
    const ops = require('../plsai-ops');
    const q = String((req.body || {}).q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });
    // Ветка «Реализация» — выгрузка с датами отгрузки/поставки.
    if (ops.looksLikeOps(q)) {
      const of = ops.parseOps(q);
      const { items } = await ops.runOps(of);
      const buf = ops.buildOpsXlsx(items, ops.interpret(of), of.field);
      const nm = 'ProLabAI_Реализация_' + q.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 34) + '.xlsx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nm)}`);
      return res.send(buf);
    }
    // Один разбор запроса (без повторного вызова ИИ).
    const a = await analyze(q);
    // Рейтинг/агрегация — выгрузка сгруппированной таблицы.
    if (a.aggregate && a.f) {
      const agg = await runAggregate(a.f);
      const buf = buildAggXlsx(agg, interpretAggregate(a.f));
      const nm = 'ProLabAI_Рейтинг_' + q.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 34) + '.xlsx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nm)}`);
      return res.send(buf);
    }
    const f = a.f || parseQuery(q);
    const { items } = await runQuery(f);
    const buf = buildXlsx(items, interpret(f));
    const name = 'ProLabAI_' + q.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 40) + '.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  } catch (e) {
    console.error('POST /api/plsai/export error:', e.message);
    res.status(500).json({ error: 'Не удалось сформировать Excel: ' + e.message });
  }
});

// GET /api/plsai/health — диагностика LLM-слоя (только админ): виден ли ключ, отвечает ли Anthropic.
router.get('/health', requireAuth(['admin']), async (req, res) => {
  try {
    const { llmSelfTest } = require('../plsai-calc');
    res.set('Cache-Control', 'no-store');
    res.json(await llmSelfTest());
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Дашборд-эндпоинты для витрины в модуле «План продаж» (явные параметры) ──
router.get('/dash/forecast', requireAuth(VIEW_ROLES), async (req, res) => {
  try { const forecast = require('../plsai-forecast'); res.set('Cache-Control', 'no-store'); res.json(await forecast.runForecast(String(req.query.q || ''))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/dash/winrate', requireAuth(VIEW_ROLES), async (req, res) => {
  try { const analytics = require('../plsai-analytics'); const g = req.query.group === 'department' ? 'по отделам' : ''; res.set('Cache-Control', 'no-store'); res.json(await analytics.runWinrates(g)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/dash/velocity', requireAuth(VIEW_ROLES), async (req, res) => {
  try { const analytics = require('../plsai-analytics'); res.set('Cache-Control', 'no-store'); res.json(await analytics.runVelocity(String(req.query.q || ''))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/plsai/me — имя текущего сотрудника для персонального приветствия.
router.get('/me', requireAuth(VIEW_ROLES), async (req, res) => {
  const u = req.user || {};
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, name: u.display_name || u.engineer_name || u.username || '' });
});

// GET /api/plsai/history — история обращений текущего сотрудника (свой диалог).
router.get('/history', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const history = require('../plsai-history');
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, items: await history.list(req.user && req.user.id, 60) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/plsai/history/clear — очистить историю текущего сотрудника.
router.post('/history/clear', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const history = require('../plsai-history');
    await history.clear(req.user && req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

// engineer (менеджеры продаж) читают план/прогноз/аналитику и пользуются ProLab AI.
// Массовые действия (рассылки, задачи) остаются за ACT_ROLES — engineer туда не входит.
const VIEW_ROLES = ['admin', 'coordinator', 'manager', 'engineer', 'store', 'accountant'];

// Bitrix-ID текущего пользователя (для «мои задачи» и авторства действий).
function meBidOf(user) {
  if (!user) return null;
  if (user.bitrix_user_id) return parseInt(user.bitrix_user_id, 10);
  const nm = user.engineer_name || user.display_name;
  if (nm) { try { const { USERS } = require('../constants'); const f = Object.entries(USERS).find(([, n]) => n === nm); if (f) return parseInt(f[0], 10); } catch (_) {} }
  return null;
}

// Выгрузка статистики по компаниям (Тотал + годы × категории) через ProLab AI.
function looksLikeStatExport(q) {
  const s = String(q || '').toLowerCase();
  const exp = /выгруз|экспорт|скач|в\s*excel|в\s*эксель|в\s*ексель|таблиц[уеа]/;
  return exp.test(s) && (/статистик/.test(s) || (/компани/.test(s) && /(год|катего|разбив|сфер)/.test(s)));
}

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
    // Сделки с неактуальными комментариями.
    const deals = require('../plsai-deals');
    if (deals.looksLikeStale(q)) {
      const r = await deals.runStale(q);
      const staleTop = r.rows.slice(0, 10);
      history.save(uid, q, { type: 'stale', stale: true, likelyOnly: r.likelyOnly, period: r.period, thresholdDays: r.thresholdDays, count: r.count, sumKzt: r.sumKzt, top: staleTop, actionable: { dealIds: r.rows.map(x => x.dealId) } });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, ai: true, stale: true, likelyOnly: r.likelyOnly, period: r.period, thresholdDays: r.thresholdDays, count: r.count, sumKzt: r.sumKzt, top: staleTop, actionable: { dealIds: r.rows.map(x => x.dealId) } });
    }
    // Оценка вероятности сделок.
    if (deals.looksLikeProbability(q)) {
      const r = await deals.runProbability(q);
      const probTop = r.rows.slice(0, 12);
      history.save(uid, q, { type: 'probability', probability: true, period: r.period, count: r.count, expected: r.expected, top: probTop, actionable: { dealIds: r.rows.map(x => x.dealId) } });
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, ai: true, probability: true, period: r.period, count: r.count, expected: r.expected, top: probTop, actionable: { dealIds: r.rows.map(x => x.dealId) } });
    }
    // Ансамбль методов / бэктест точности.
    if (/ансамбл|бэктест|бектест|точност[а-яё]* метод|какой метод точн|сравни методы/.test(q.toLowerCase())) {
      const en = await require('../plsai-wave3').ensembleBacktest();
      history.save(uid, q, { type: 'ensemble', ensembleOnly: true, ensemble: en });
      res.set('Cache-Control', 'no-store'); return res.json({ ok: true, ai: true, ensembleOnly: true, ensemble: en });
    }
    // ML-скоринг сделок (propensity).
    if (/\bml\b|скоринг|propensity|перспективн[а-яё]* сделк|вероятн[а-яё]* подписани/.test(q.toLowerCase())) {
      const ml = await require('../plsai-wave3').mlPropensity();
      history.save(uid, q, { type: 'ml', ml });
      res.set('Cache-Control', 'no-store'); return res.json({ ok: true, ai: true, ml });
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
    // Выгрузка статистики по компаниям в Excel.
    if (looksLikeStatExport(q)) {
      const payload = { ok: true, ai: false, statExport: true, kind: 'companies', q, label: 'Статистика по компаниям — Тотал и годы, разбивка по категориям (Приборы / ОРМ / Сервис / ТЦ)' };
      history.save(uid, q, Object.assign({ type: 'statExport' }, payload));
      res.set('Cache-Control', 'no-store');
      return res.json(payload);
    }
    // Трекер задач Bitrix по сделкам: кто и как выполняет (Реализация / План продаж / оба).
    const tasksMod = require('../plsai-tasks');
    if (tasksMod.looksLikeTasks(q)) {
      const t = await tasksMod.runTasks(q, { meBid: meBidOf(req.user) });
      // Людей — топ 15; у каждого 6 задач для раскрытия. Детали — в Excel.
      const people = t.people.slice(0, 15).map(p => ({ responsible: p.responsible, responsibleId: p.responsibleId, assigned: p.assigned, done: p.done, open: p.open, overdue: p.overdue, pct: p.pct,
        tasks: p.tasks.slice(0, 6).map(x => ({ title: x.title, statusLabel: x.statusLabel, done: x.done, overdue: x.overdue, deadline: x.deadline, company: x.company, dealId: x.dealId })) }));
      const payload = { ok: true, ai: true, tasks: true, module: t.module, moduleLabel: t.moduleLabel, overdueOnly: t.overdueOnly, openOnly: t.openOnly, mineOnly: t.mineOnly, totals: t.totals, people, actionable: t.actionable };
      history.save(uid, q, Object.assign({ type: 'tasks' }, payload));
      res.set('Cache-Control', 'no-store');
      return res.json(payload);
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
    // Открытый вопрос (про систему/данные/статус, не типовая выборка сделок) —
    // отдаём агенту с доступом к данным ЦУПа (роль-скоуп внутри). Если агент
    // недоступен (нет ключа/ошибка) — откатываемся на короткий текст-ответ.
    if (a.kind === 'assistant') {
      try {
        const agent = require('../plsai-agent');
        const r = await agent.runAgent(q, req.user);
        if (r && r.ok && r.answer) {
          history.save(uid, q, { type: 'agent', answer: r.answer, ai: true });
          res.set('Cache-Control', 'no-store');
          return res.json({ ok: true, answer: r.answer, ai: true, kind: 'assistant', agent: true, steps: (r.steps || []).map(s => ({ purpose: s.purpose, rowCount: s.rowCount, error: s.error })) });
        }
      } catch (e) { console.error('agent fallback error:', e.message); }
      if (a.answer) {
        history.save(uid, q, { type: 'assistant', answer: a.answer, ai: true });
        res.set('Cache-Control', 'no-store'); return res.json({ ok: true, answer: a.answer, ai: true, kind: 'assistant' });
      }
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

// POST /api/plsai/agent { q } — прямой вызов агента с доступом к данным ЦУПа
// (read-only, роль-скоуп внутри). Ответ текстом (+ шаги для прозрачности).
router.post('/agent', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const agent = require('../plsai-agent');
    const q = String((req.body || {}).q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });
    const r = await agent.runAgent(q, req.user);
    res.set('Cache-Control', 'no-store');
    if (!r.ok) return res.status(200).json({ ok: false, error: r.error, steps: r.steps || [] });
    try { require('../plsai-history').save(req.user && req.user.id, q, { type: 'agent', answer: r.answer, ai: true }); } catch (_) {}
    return res.json({ ok: true, ai: true, kind: 'assistant', agent: true, answer: r.answer, model: r.model,
      steps: (r.steps || []).map(s => ({ purpose: s.purpose, sql: s.sql, rowCount: s.rowCount, error: s.error })) });
  } catch (e) {
    console.error('POST /api/plsai/agent error:', e.message);
    res.status(500).json({ error: 'Агент недоступен: ' + e.message });
  }
});

// POST /api/plsai/export { q } — тот же запрос, но отдаём Excel-файл.
router.post('/export', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { parseQuery, analyze, runQuery, interpret, buildXlsx, runAggregate, interpretAggregate, buildAggXlsx } = require('../plsai-calc');
    const ops = require('../plsai-ops');
    const q = String((req.body || {}).q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });
    // Выгрузка статистики по компаниям (Тотал + годы × категории).
    if (looksLikeStatExport(q)) {
      const { buildCompaniesPivotWorkbook } = require('../stats-export');
      const { buffer, fname } = await buildCompaniesPivotWorkbook();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
      return res.end(buffer);
    }
    // Актуальные/просроченные задачи — выгрузка (строка на задачу). ВАЖНО: раньше «Реализации»,
    // иначе looksLikeOps перехватит запрос со словом «Реализация» и вернёт отгрузку.
    const tasksMod = require('../plsai-tasks');
    if (tasksMod.looksLikeTasks(q)) {
      const t = await tasksMod.runTasks(q, { meBid: meBidOf(req.user) });
      const buf = tasksMod.buildTasksXlsx(t);
      const nm = 'ProLabAI_Задачи_' + q.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 34) + '.xlsx';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(nm)}`);
      return res.send(buf);
    }
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
    // Неактуальные комментарии — выгрузка всех.
    const dealsMod = require('../plsai-deals');
    if (dealsMod.looksLikeStale(q)) {
      const r = await dealsMod.runStale(q);
      const buf = dealsMod.buildStaleXlsx(r);
      const nm = 'ProLabAI_Неактуальные_' + q.replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 34) + '.xlsx';
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
  try { const analytics = require('../plsai-analytics'); const q = (req.query.group === 'department' ? 'по отделам ' : '') + String(req.query.period || ''); res.set('Cache-Control', 'no-store'); res.json(await analytics.runWinrates(q)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/dash/velocity', requireAuth(VIEW_ROLES), async (req, res) => {
  try { const analytics = require('../plsai-analytics'); res.set('Cache-Control', 'no-store'); res.json(await analytics.runVelocity(String(req.query.period || req.query.q || ''))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/dash/cohort', requireAuth(VIEW_ROLES), async (req, res) => {
  try { const w2 = require('../plsai-wave2'); res.set('Cache-Control', 'no-store'); res.json({ ok: true, cohort: await w2.cohortMaturation(), stages: await w2.empiricalStageProbs(), trend: await w2.salesTrend() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Детализация прогноза по отделу: сделки, из которых складывается подписано/воронка.
router.get('/dash/forecast-deals', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const dept = String(req.query.dept || '').trim();
    if (!dept) return res.status(400).json({ ok: false, error: 'Не указан отдел' });
    const out = await require('../plsai-forecast').forecastDealsByDept(q, dept);
    res.set('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true }, out));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/dash/ml', requireAuth(VIEW_ROLES), async (req, res) => {
  try { const w3 = require('../plsai-wave3'); res.set('Cache-Control', 'no-store'); res.json({ ok: true, ml: await w3.mlPropensity() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Действия (с подтверждением): подготовка превью и отправка ──
const ACT_ROLES = ['admin', 'coordinator', 'manager'];
router.post('/action/prepare', requireAuth(ACT_ROLES), express.json(), async (req, res) => {
  try {
    const actions = require('../plsai-actions');
    const b = req.body || {};
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, preview: await actions.prepare({ dealIds: b.dealIds || [], channel: b.channel, target: b.target, text: b.text, mode: b.mode }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/action/execute', requireAuth(ACT_ROLES), express.json(), async (req, res) => {
  try {
    const actions = require('../plsai-actions');
    const b = req.body || {};
    const out = await actions.execute({ dealIds: b.dealIds || [], channel: b.channel, target: b.target, text: b.text, mode: b.mode, userName: (req.user && req.user.display_name) || '' });
    try { require('../auth').auditLog && require('../auth').auditLog(req.user.id, req.user.username, 'plsai_action', null, { channel: out.channel, target: out.target, sent: out.sent, total: out.total }, req.ip, ''); } catch (_) {}
    res.set('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true }, out));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

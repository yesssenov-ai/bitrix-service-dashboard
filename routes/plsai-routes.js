const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator', 'manager', 'store', 'accountant'];

// POST /api/plsai/query { q } — разобрать запрос и вернуть сводку + образец строк.
router.post('/query', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { analyze, runQuery, interpret } = require('../plsai-calc');
    const q = String((req.body || {}).q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });
    const a = await analyze(q);
    // Ассистент ответил текстом (вопрос про систему/модули/статус, не выборка сделок).
    if (a.kind === 'assistant' && a.answer) { res.set('Cache-Control', 'no-store'); return res.json({ ok: true, answer: a.answer, ai: true, kind: 'assistant' }); }
    if (!a.f && a.clarify) { res.set('Cache-Control', 'no-store'); return res.json({ ok: true, clarify: a.clarify, ai: true }); }
    const { items, count, sumKzt } = await runQuery(a.f);
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
    const { parseSmart, runQuery, interpret, buildXlsx } = require('../plsai-calc');
    const q = String((req.body || {}).q || '').trim();
    if (!q) return res.status(400).json({ error: 'Пустой запрос' });
    const f = await parseSmart(q);
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

module.exports = { router };

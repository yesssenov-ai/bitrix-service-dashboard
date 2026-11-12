// API модуля «База знаний». Чтение/поиск — любой авторизованный; управление
// (добавить/изменить/удалить регламент) — admin. Агент использует knowledge-calc
// напрямую (kbContext), а не эти роуты.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const kb = require('../knowledge-calc');

const ADMIN = ['admin'];

router.get('/docs', requireAuth([]), async (req, res) => {
  try { res.json({ ok: true, items: await kb.listDocs() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/docs/:id(\\d+)', requireAuth([]), async (req, res) => {
  try { const d = await kb.getDoc(+req.params.id); if (!d) return res.status(404).json({ ok: false, error: 'Не найдено' }); res.json({ ok: true, doc: d }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/docs', requireAuth(ADMIN), express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.title || '').trim() && !String(b.body || '').trim()) return res.status(400).json({ ok: false, error: 'Укажите название и текст' });
    const r = await kb.addDoc({ title: b.title, category: b.category, source: b.source, body: b.body, by: req.user.display_name || req.user.username });
    res.json({ ok: true, id: r.id, chunks: r.chunks });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/docs/:id(\\d+)', requireAuth(ADMIN), express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await kb.updateDoc(+req.params.id, { title: b.title, category: b.category, source: b.source, body: b.body });
    if (!r) return res.status(404).json({ ok: false, error: 'Не найдено' });
    res.json({ ok: true, id: r.id, chunks: r.chunks });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/docs/:id(\\d+)', requireAuth(ADMIN), async (req, res) => {
  try { await kb.deleteDoc(+req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/docs/:id(\\d+)/reindex', requireAuth(ADMIN), async (req, res) => {
  try { const n = await kb.reindexDoc(+req.params.id); res.json({ ok: true, chunks: n }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Проверка извлечения (как агент видит знания по запросу).
router.get('/search', requireAuth([]), async (req, res) => {
  try { res.json({ ok: true, results: await kb.kbSearch(req.query.q, req.query.limit) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

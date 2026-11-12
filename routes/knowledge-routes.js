// API модуля «База знаний». Чтение/поиск — любой авторизованный; управление
// (добавить/изменить/удалить регламент) — admin. Агент использует knowledge-calc
// напрямую (kbContext), а не эти роуты.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth } = require('../auth');
const kb = require('../knowledge-calc');

const ADMIN = ['admin'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Загрузка регламента файлом: txt/md/docx/pdf → текст → в базу знаний.
// Парсеры (mammoth/pdf-parse) подключаются лениво — если пакет не установлен,
// просто вернётся понятная ошибка, приложение не падает.
router.post('/upload', requireAuth(ADMIN), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Файл не передан' });
    const name = req.file.originalname || 'Документ';
    const ext = (name.split('.').pop() || '').toLowerCase();
    const buf = req.file.buffer;
    let text = '';
    if (ext === 'txt' || ext === 'md' || ext === 'csv' || (req.file.mimetype || '').startsWith('text/')) {
      text = buf.toString('utf8');
    } else if (ext === 'docx') {
      try { const mammoth = require('mammoth'); const r = await mammoth.extractRawText({ buffer: buf }); text = r.value || ''; }
      catch (e) { return res.status(400).json({ ok: false, error: 'Не удалось разобрать DOCX (' + e.message + ')' }); }
    } else if (ext === 'pdf') {
      try { const pdf = require('pdf-parse'); const r = await pdf(buf); text = r.text || ''; }
      catch (e) { return res.status(400).json({ ok: false, error: 'Не удалось разобрать PDF (' + e.message + ')' }); }
    } else {
      return res.status(400).json({ ok: false, error: 'Поддерживаются файлы txt, md, docx, pdf' });
    }
    text = String(text).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'В файле не найден текст (возможно, это скан — нужен OCR, или пустой документ)' });
    const title = (req.body && String(req.body.title || '').trim()) || name.replace(/\.[^.]+$/, '');
    const purpose = (req.body && String(req.body.desc || req.body.purpose || '').trim()) || '';
    // Оригинальный файл кладём в объектное хранилище (для скачивания человеком).
    // Если хранилище не настроено/недоступно — не падаем: текст уже извлечён.
    let att = null;
    try {
      const storage = require('../storage-lib');
      if (storage.configured()) {
        await storage.ensureBucket();
        const okey = `kb/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await storage.upload(okey, buf, req.file.mimetype || 'application/octet-stream');
        att = { name, key: okey, type: req.file.mimetype || '' };
      }
    } catch (e) { console.error('kb file store:', e.message); }
    const r = await kb.addDoc({ title, category: (req.body && req.body.category) || '', source: name, body: text, purpose, att, by: req.user.display_name || req.user.username });
    res.json({ ok: true, id: r.id, chunks: r.chunks, title, length: text.length, stored: !!att });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
    const r = await kb.addDoc({ title: b.title, category: b.category, source: b.source, body: b.body, purpose: b.purpose, by: req.user.display_name || req.user.username });
    res.json({ ok: true, id: r.id, chunks: r.chunks });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/docs/:id(\\d+)', requireAuth(ADMIN), express.json({ limit: '4mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const r = await kb.updateDoc(+req.params.id, { title: b.title, category: b.category, source: b.source, body: b.body, purpose: b.purpose });
    if (!r) return res.status(404).json({ ok: false, error: 'Не найдено' });
    res.json({ ok: true, id: r.id, chunks: r.chunks });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Скачать оригинальный файл регламента (docx/pdf), если он был загружен файлом.
router.get('/docs/:id(\\d+)/file', requireAuth([]), async (req, res) => {
  try {
    const d = await kb.getDoc(+req.params.id);
    if (!d || !d.att_key) return res.status(404).json({ ok: false, error: 'У регламента нет вложенного файла' });
    const storage = require('../storage-lib');
    if (!storage.configured()) return res.status(503).json({ ok: false, error: 'Хранилище файлов не настроено' });
    const url = await storage.signedUrl(d.att_key, 300);
    if (!url) return res.status(404).json({ ok: false, error: 'Файл недоступен' });
    res.redirect(url);
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
// Статус семантики (включены ли эмбеддинги).
router.get('/status', requireAuth([]), async (req, res) => {
  try { res.json(Object.assign({ ok: true }, kb.kbStatus())); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Пересчитать эмбеддинги по всем регламентам (после включения провайдера).
router.post('/reembed', requireAuth(ADMIN), async (req, res) => {
  try { res.json(await kb.reembedAll()); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

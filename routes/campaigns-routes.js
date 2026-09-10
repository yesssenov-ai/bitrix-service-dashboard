// Модуль «Рассылки» — API. Доступ к модулю по гранту (requireModule('CAM') на
// странице). Действия — управляющим ролям (админ/координатор/менеджер).
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW = ['admin', 'coordinator', 'manager', 'store', 'engineer', 'viewer', 'marketolog'];
const EDIT = ['admin', 'coordinator', 'manager', 'marketolog'];

// Аудитория
router.get('/industries', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../campaigns-calc').getIndustries()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/companies', requireAuth(VIEW), async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q) return res.json({ companies: await require('../campaigns-calc').searchCompanies(q), search: true });
    res.json({ companies: await require('../campaigns-calc').getCompanies(req.query.industry || '') });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/sync', requireAuth(EDIT), async (req, res) => {
  try {
    // запускаем в фоне — синк может идти минуту-две
    require('../campaigns-calc').syncAudience().catch(e => console.error('campaigns sync:', e.message));
    res.json({ ok: true, started: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Кампании
router.get('/', requireAuth(VIEW), async (req, res) => {
  try { res.json({ campaigns: await require('../campaigns-calc').listCampaigns() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/', requireAuth(EDIT), express.json({ limit: '2mb' }), async (req, res) => {
  try { res.json(await require('../campaigns-calc').createCampaign(req.body || {}, req.user.bitrix_user_id || null)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/:id(\\d+)', requireAuth(VIEW), async (req, res) => {
  try {
    const c = await require('../campaigns-calc').getCampaign(parseInt(req.params.id, 10));
    if (!c) return res.status(404).json({ error: 'Не найдено' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/:id(\\d+)', requireAuth(EDIT), express.json({ limit: '2mb' }), async (req, res) => {
  try { res.json(await require('../campaigns-calc').updateCampaign(parseInt(req.params.id, 10), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Удаление рассылки (черновик/отправленная) — ТОЛЬКО админ. Удаляет и получателей,
// и статистику, и файлы (каскадом). Действие необратимо.
router.delete('/:id(\\d+)', requireAuth(['admin']), async (req, res) => {
  try { res.json(await require('../campaigns-calc').deleteCampaign(parseInt(req.params.id, 10))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/recipients', requireAuth(EDIT), express.json({ limit: '4mb' }), async (req, res) => {
  try { res.json(await require('../campaigns-calc').setRecipients(parseInt(req.params.id, 10), (req.body || {}).emails || [])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/:id/send', requireAuth(EDIT), async (req, res) => {
  try {
    const r = await require('../campaigns-calc').sendCampaign(parseInt(req.params.id, 10));
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Файлы кампании (вложения / ссылки) ──────────────────────────────────────
router.get('/:id/files', requireAuth(VIEW), async (req, res) => {
  try { res.json({ files: await require('../campaigns-calc').listFiles(parseInt(req.params.id, 10)) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Загрузка файла — base64 в JSON (лимит поднят под размер файла + оверхед base64).
router.post('/:id/files', requireAuth(EDIT), express.json({ limit: '12mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const f = await require('../campaigns-calc').addFile(parseInt(req.params.id, 10), {
      filename: b.filename, mime: b.mime, dataBase64: b.dataBase64, kind: b.kind,
    });
    res.json({ ok: true, file: f });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.put('/:id/files/:fid', requireAuth(EDIT), express.json(), async (req, res) => {
  try { res.json(await require('../campaigns-calc').setFileKind(parseInt(req.params.id, 10), parseInt(req.params.fid, 10), (req.body || {}).kind)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/:id/files/:fid', requireAuth(EDIT), async (req, res) => {
  try { res.json(await require('../campaigns-calc').deleteFile(parseInt(req.params.id, 10), parseInt(req.params.fid, 10))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Публичное скачивание файла по токену (кликают получатели из письма).
router.get('/file/:token', async (req, res) => {
  try {
    const f = await require('../campaigns-calc').getFileByToken(req.params.token);
    if (!f) return res.status(404).send('Файл не найден');
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.filename || 'file') + '"');
    res.send(Buffer.from(f.data));
  } catch (e) { res.status(500).send('Ошибка'); }
});

// Публичная отписка (без авторизации).
router.get('/unsub', async (req, res) => {
  const email = require('../campaigns-calc').unsubVerify(req.query.t || '');
  if (email) { try { await require('../campaigns-calc').suppress(email, 'unsub'); } catch (e) {} }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <div style="font-family:Inter,Arial,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#1a1e27">
      <h2>${email ? 'Вы отписались от рассылки' : 'Ссылка недействительна'}</h2>
      <p style="color:#6b7280">${email ? 'Больше писем на этот адрес мы не отправим. Спасибо!' : 'Проверьте ссылку из письма.'}</p>
    </div>`);
});

// ── Аналитика рассылок ──────────────────────────────────────────────────────
// Сводная по всем отправленным кампаниям.
router.get('/analytics/overall', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../campaigns-stats').getOverall()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Аналитика по одной кампании (воронка + детализация по адресатам).
router.get('/:id(\\d+)/analytics', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../campaigns-stats').getCampaignAnalytics(parseInt(req.params.id, 10))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Подтянуть свежие статусы из Selzy по кампании и вернуть обновлённую аналитику.
router.post('/:id(\\d+)/analytics/refresh', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../campaigns-stats').refreshCampaign(parseInt(req.params.id, 10))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Логотип письма (заменяемый) ─────────────────────────────────────────────
const LOGO_EDIT = ['admin', 'marketolog'];   // менять логотип могут админ и маркетолог

// Публичная выдача логотипа футера (его грузят почтовые клиенты получателей).
// Если логотип заменён — отдаём из БД; иначе — дефолтный файл из /assets.
router.get('/logo', async (req, res) => {
  try {
    const a = await require('../campaigns-calc').getAsset('footer_logo');
    if (a && a.data) {
      res.set('Content-Type', a.mime || 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.send(Buffer.from(a.data));
    }
    const path = require('path'), fs = require('fs');
    const def = path.join(__dirname, '..', 'public', 'assets', 'company-full-logo.png');
    if (fs.existsSync(def)) {
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=300');
      return res.send(fs.readFileSync(def));
    }
    res.status(404).send('нет логотипа');
  } catch (e) { res.status(500).send('Ошибка'); }
});

// Инфо о текущем логотипе (для интерфейса): заменён или дефолтный + время.
router.get('/logo/info', requireAuth(VIEW), async (req, res) => {
  try {
    const a = await require('../campaigns-calc').getAsset('footer_logo');
    res.json({ custom: !!(a && a.data), mime: a ? a.mime : null, updatedAt: a ? a.updatedAt : null,
      canEdit: LOGO_EDIT.includes(req.user.role) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Загрузить новый логотип (admin/marketolog). Принимает { dataBase64, mime }.
router.post('/logo', requireAuth(LOGO_EDIT), express.json({ limit: '8mb' }), async (req, res) => {
  try {
    const { dataBase64, mime } = req.body || {};
    if (!dataBase64) return res.status(400).json({ error: 'Нет изображения' });
    const okMime = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/i.test(mime || '');
    if (!okMime) return res.status(400).json({ error: 'Только изображение (PNG, JPG, GIF, WEBP, SVG)' });
    const buf = Buffer.from(dataBase64, 'base64');
    if (buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'Файл больше 6 МБ' });
    await require('../campaigns-calc').setAsset('footer_logo', mime, buf, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Сбросить логотип к дефолтному (admin/marketolog).
router.delete('/logo', requireAuth(LOGO_EDIT), async (req, res) => {
  try { await require('../campaigns-calc').deleteAsset('footer_logo'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

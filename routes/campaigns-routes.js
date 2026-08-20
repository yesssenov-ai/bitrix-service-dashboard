// Модуль «Рассылки» — API. Доступ к модулю по гранту (requireModule('CAM') на
// странице). Действия — управляющим ролям (админ/координатор/менеджер).
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW = ['admin', 'coordinator', 'manager', 'store', 'engineer', 'viewer'];
const EDIT = ['admin', 'coordinator', 'manager'];

// Аудитория
router.get('/industries', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../campaigns-calc').getIndustries()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/companies', requireAuth(VIEW), async (req, res) => {
  try { res.json({ companies: await require('../campaigns-calc').getCompanies(req.query.industry || '') }); }
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
router.get('/:id', requireAuth(VIEW), async (req, res) => {
  try {
    const c = await require('../campaigns-calc').getCampaign(parseInt(req.params.id, 10));
    if (!c) return res.status(404).json({ error: 'Не найдено' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/:id', requireAuth(EDIT), express.json({ limit: '2mb' }), async (req, res) => {
  try { res.json(await require('../campaigns-calc').updateCampaign(parseInt(req.params.id, 10), req.body || {})); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/:id', requireAuth(EDIT), async (req, res) => {
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

module.exports = { router };

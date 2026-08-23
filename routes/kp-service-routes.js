const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW_ROLES = ['admin', 'coordinator', 'manager', 'engineer', 'store'];
const RESEND_KEY = process.env.RESEND_API_KEY;

function fmtDate(d) { const x = d || new Date(); const p = n => String(n).padStart(2, '0'); return `${p(x.getDate())}.${p(x.getMonth() + 1)}.${x.getFullYear()}г.`; }

// GET /api/kp-service/meta — пресеты услуг + данные «ответственного» (текущий юзер).
router.get('/meta', requireAuth(VIEW_ROLES), (req, res) => {
  const { PRESETS, senderFor } = require('../kp-service-calc');
  res.json({ presets: PRESETS, sender: senderFor(req.user), today: fmtDate(new Date()) });
});

// GET /api/kp-service/candidates — таргетинг «кому предложить сервис».
router.get('/candidates', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { serviceCandidates } = require('../kp-service-calc');
    res.set('Cache-Control', 'no-store');
    res.json({ items: await serviceCandidates() });
  } catch (e) {
    console.error('GET /api/kp-service/candidates error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// POST /api/kp-service/cover — текст сопроводительного письма по шаблону.
router.post('/cover', requireAuth(VIEW_ROLES), express.json(), (req, res) => {
  const { coverLetter, senderFor } = require('../kp-service-calc');
  const b = req.body || {};
  res.json({ text: coverLetter({ greetingName: b.greetingName, equipment: b.equipment, sender: senderFor(req.user) }) });
});

// Собрать файл КП в нужном формате. Возвращает { buf, name, mime }.
async function buildKpFile(kp, format) {
  const slug = String((kp && kp.client) || '').replace(/[^\wа-яА-Я0-9]+/g, '_').slice(0, 40);
  if (format === 'docx') {
    const { buildServiceKpDocx } = require('../kp-service-docx');
    return { buf: await buildServiceKpDocx(kp), name: 'KP_Service_' + slug + '.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  const { buildServiceKpPdf } = require('../kp-service-pdf');
  return { buf: await buildServiceKpPdf(kp), name: 'KP_Service_' + slug + '.pdf', mime: 'application/pdf' };
}

// POST /api/kp-service/generate — сформировать КП (PDF по умолчанию, ?format=docx) и отдать на скачивание.
router.post('/generate', requireAuth(VIEW_ROLES), express.json({ limit: '2mb' }), async (req, res) => {
  try {
    const format = (req.query.format === 'docx' || (req.body && req.body.format) === 'docx') ? 'docx' : 'pdf';
    const { buf, name, mime } = await buildKpFile(req.body || {}, format);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(buf);
  } catch (e) {
    console.error('POST /api/kp-service/generate error:', e.message);
    res.status(500).json({ error: 'Не удалось сформировать КП: ' + e.message });
  }
});

// POST /api/kp-service/send — отправить КП клиенту письмом ОТ имени текущего
// пользователя (Resend, From = его @prolabsupport.kz, Reply-To — он же), с DOCX во вложении.
router.post('/send', requireAuth(VIEW_ROLES), express.json({ limit: '2mb' }), async (req, res) => {
  try {
    if (!RESEND_KEY) return res.status(400).json({ error: 'RESEND_API_KEY не задан' });
    const { senderFor } = require('../kp-service-calc');
    const b = req.body || {};
    const to = String(b.to || '').trim();
    if (!to) return res.status(400).json({ error: 'Укажите e-mail получателя' });
    const sender = senderFor(req.user);
    const fromEmail = sender.email && /@prolabsupport\.kz$/i.test(sender.email) ? sender.email : 'service@prolabsupport.kz';
    const format = (b.format === 'docx') ? 'docx' : 'pdf';
    const { buf, name: fileName } = await buildKpFile(b.kp || {}, format);
    const html = '<div style="font-family:Arial,sans-serif;white-space:pre-wrap;font-size:14px;line-height:1.5">' +
      String(b.cover || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</div>';
    const payload = {
      from: `${sender.name || 'ProLabSupport'} <${fromEmail}>`,
      to: [to], reply_to: fromEmail,
      subject: b.subject || 'Коммерческое предложение на сервисное обслуживание — ProLabSupport',
      html,
      attachments: [{ filename: fileName, content: buf.toString('base64') }],
    };
    if (b.cc) payload.cc = Array.isArray(b.cc) ? b.cc : [b.cc];
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (d && d.message) || 'Resend error' });
    res.json({ ok: true, id: d.id, from: fromEmail });
  } catch (e) {
    console.error('POST /api/kp-service/send error:', e.message);
    res.status(500).json({ error: 'Не удалось отправить: ' + e.message });
  }
});

module.exports = { router };

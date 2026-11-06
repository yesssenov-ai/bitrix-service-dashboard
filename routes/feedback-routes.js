// Обратная связь сотрудников: «Предложить улучшение / Сообщить о проблеме».
// Кнопка на всех страницах → POST сюда → запись в БД + уведомление в Telegram/почту.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
let notif = null; try { notif = require('../notifications'); } catch (e) { /* уведомления опциональны */ }

const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Разрешённые типы вложений и лимиты. Храним base64 data URL прямо в БД.
const ATTACH_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i;
const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_ATTACH_BYTES = 6 * 1024 * 1024; // ~6 МБ после декодирования base64

// Достаёт и проверяет вложение из тела. Возвращает { data, name, type } или null.
function parseAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const data = String(a.data || '');
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!ATTACH_MIME.test(type)) throw new Error('Можно прикрепить только картинку или PDF');
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_ATTACH_BYTES) throw new Error('Файл слишком большой (макс. 6 МБ)');
  const rawName = String(a.name || '').replace(/[\r\n]/g, '').slice(0, 200);
  const name = rawName || ('attachment.' + (EXT_OF[type] || 'bin'));
  return { data, name, type };
}

// POST /api/feedback — отправить идею/проблему (+ необязательное вложение). Любой авторизованный.
router.post('/', requireAuth(), express.json({ limit: '9mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Напишите сообщение' });
    if (text.length > 4000) return res.status(400).json({ ok: false, error: 'Слишком длинно (макс. 4000 символов)' });
    const kind = b.kind === 'problem' ? 'problem' : 'idea';
    const page = String(b.page || '').slice(0, 300);
    const module = String(b.module || '').slice(0, 120);
    let att = null;
    try { att = parseAttachment(b.attachment); }
    catch (ae) { return res.status(400).json({ ok: false, error: ae.message }); }
    const u = req.user;
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_feedback (user_id, username, display_name, kind, page, module, text, user_agent, attachment_data, attachment_name, attachment_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [u.id, u.username, u.display_name, kind, page, module, text, String(req.headers['user-agent'] || '').slice(0, 400),
       att ? att.data : null, att ? att.name : null, att ? att.type : null]
    );
    // Уведомление управленцам (не блокирует ответ).
    try {
      const who = u.display_name || u.username;
      const label = kind === 'problem' ? '🐞 Проблема' : '💡 Идея';
      const where = module || page || '—';
      if (notif && notif.tgMgt) {
        const sent = notif.tgMgt(`${label} · ЦУП\nОт: ${who}\nМодуль: ${where}\n\n${text}`);
        // Вложение отправляем отдельным фото/документом — чтобы открывалось прямо в TG.
        if (att && notif.tgMgtAttachment) {
          Promise.resolve(sent).then(() => notif.tgMgtAttachment(att.data, att.name, `📎 Вложение · ${esc(who)}`)).catch(() => {});
        }
      }
      if (notif && notif.sendEmail) notif.sendEmail(
        `ЦУП: ${label} от ${who}`,
        `<p><b>${label}</b> · ${esc(who)} · ${esc(where)}</p><pre style="white-space:pre-wrap;font:inherit">${esc(text)}</pre>` +
          (att ? `<p style="color:#6a7488">📎 Вложение: ${esc(att.name)} — смотрите в админке ЦУП.</p>` : '')
      );
    } catch (e) { console.error('feedback notify:', e.message); }
    res.json({ ok: true, id: rows[0].id });
  } catch (e) {
    console.error('feedback POST:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось отправить. Попробуйте ещё раз.' });
  }
});

// GET /api/feedback/list — последние обращения (для админов/суперадминов).
router.get('/list', requireAuth(['admin', 'superadmin']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, display_name, username, kind, page, module, text, status, created_at,
              (attachment_data IS NOT NULL) AS has_attachment, attachment_name, attachment_type
         FROM ticketsmodule_feedback ORDER BY created_at DESC LIMIT 300`
    );
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/feedback/:id/attachment — отдать вложение (админ/суперадмин).
// ?dl=1 — скачать файлом; иначе показать в браузере (inline).
router.get('/:id(\\d+)/attachment', requireAuth(['admin', 'superadmin']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT attachment_data, attachment_name, attachment_type FROM ticketsmodule_feedback WHERE id=$1',
      [parseInt(req.params.id, 10)]
    );
    const r = rows[0];
    if (!r || !r.attachment_data) return res.status(404).send('Нет вложения');
    const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(r.attachment_data);
    if (!m) return res.status(404).send('Повреждённое вложение');
    const buf = Buffer.from(m[2], 'base64');
    const name = (r.attachment_name || 'attachment').replace(/[^\w.\-]+/g, '_');
    const disp = req.query.dl ? 'attachment' : 'inline';
    res.set('Content-Type', r.attachment_type || m[1] || 'application/octet-stream');
    res.set('Content-Disposition', `${disp}; filename="${name}"`);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(buf);
  } catch (e) { res.status(500).send(e.message); }
});

// PUT /api/feedback/:id/status { status } — пометить seen/done (админ/суперадмин).
router.put('/:id(\\d+)/status', requireAuth(['admin', 'superadmin']), express.json(), async (req, res) => {
  try {
    const st = ['new', 'seen', 'done'].includes(req.body && req.body.status) ? req.body.status : 'seen';
    await pool.query('UPDATE ticketsmodule_feedback SET status=$1 WHERE id=$2', [st, parseInt(req.params.id, 10)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

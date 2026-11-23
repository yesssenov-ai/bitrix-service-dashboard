// Обратная связь сотрудников: «Предложить улучшение / Сообщить о проблеме».
// Кнопка на всех страницах → POST сюда → запись в БД + уведомление в Telegram/почту.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
let notif = null; try { notif = require('../notifications'); } catch (e) { /* уведомления опциональны */ }
let push = null; try { push = require('../push'); } catch (e) { /* пуши опциональны */ }

const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// Кому слать обратную связь в Telegram: суперадмины (я и Дима) с привязанным
// Telegram — chat_id берём из уже существующей связки ticketsmodule_telegram_links.
// Если ни у кого нет привязки — вернём [], и notifications уйдёт в фолбэк (env → чат Руководства).
async function feedbackRecipients() {
  try {
    const { rows } = await pool.query(
      `SELECT tl.telegram_chat_id
         FROM ticketsmodule_users u
         JOIN ticketsmodule_telegram_links tl ON tl.bitrix_user_id = u.bitrix_user_id
        WHERE u.role = 'superadmin' AND tl.telegram_chat_id IS NOT NULL`
    );
    return rows.map(r => String(r.telegram_chat_id)).filter(Boolean);
  } catch (e) { console.error('feedback recipients:', e.message); return []; }
}

// Bitrix-id суперадминов (я и Дима) — для пуша в ЦУП о новом обращении.
async function superadminBids() {
  try {
    const { rows } = await pool.query(
      "SELECT bitrix_user_id FROM ticketsmodule_users WHERE role='superadmin' AND bitrix_user_id IS NOT NULL AND active=true"
    );
    return rows.map(r => r.bitrix_user_id).filter(Boolean);
  } catch (e) { console.error('feedback superadminBids:', e.message); return []; }
}

// Автору обращения: Telegram (по привязке) + веб-пуш в ЦУП, когда обращение
// отработано. Возвращает тихо (best-effort), ошибки не роняют статус-апдейт.
async function notifyAuthorResolved(fb) {
  if (!fb) return;
  const kindLbl = fb.kind === 'problem' ? 'проблема' : 'идея';
  const short = String(fb.text || '').replace(/\s+/g, ' ').slice(0, 140);
  try {
    const { rows } = await pool.query(
      `SELECT u.bitrix_user_id AS bid, tl.telegram_chat_id AS chat
         FROM ticketsmodule_users u
         LEFT JOIN ticketsmodule_telegram_links tl ON tl.bitrix_user_id = u.bitrix_user_id
        WHERE u.id = $1`, [fb.user_id]);
    const row = rows[0] || {};
    if (row.chat && notif && notif.tgTo) {
      await notif.tgTo(String(row.chat), `✅ Ваше обращение отработано\nТип: ${kindLbl}\n\n«${short}»\n\nСпасибо за обратную связь!`).catch(() => {});
    }
    if (row.bid && push && push.sendToUser) {
      await push.sendToUser(row.bid, { type: 'alert', notify: { title: '✅ Обращение отработано', body: `Ваша ${kindLbl}: ${short.slice(0, 90)}` }, url: '/portal.html' }).catch(() => {});
    }
  } catch (e) { console.error('feedback notifyAuthorResolved:', e.message); }
}

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
      if (notif && notif.tgFeedback) {
        const recips = await feedbackRecipients();
        const sent = notif.tgFeedback(`${label} · ЦУП\nОт: ${who}\nМодуль: ${where}\n\n${text}`, recips);
        // Вложение отправляем отдельным фото/документом — чтобы открывалось прямо в TG.
        if (att && notif.tgFeedbackAttachment) {
          Promise.resolve(sent).then(() => notif.tgFeedbackAttachment(att.data, att.name, `📎 Вложение · ${esc(who)}`, recips)).catch(() => {});
        }
      }
      if (notif && notif.sendEmail) notif.sendEmail(
        `ЦУП: ${label} от ${who}`,
        `<p><b>${label}</b> · ${esc(who)} · ${esc(where)}</p><pre style="white-space:pre-wrap;font:inherit">${esc(text)}</pre>` +
          (att ? `<p style="color:#6a7488">📎 Вложение: ${esc(att.name)} — смотрите в админке ЦУП.</p>` : '')
      );
      // Веб-пуш в ЦУП мне и Диме (суперадминам) — помимо TG/почты.
      if (push && push.sendToUser) {
        const bids = await superadminBids();
        const body = `${who}: ${String(text).replace(/\s+/g, ' ').slice(0, 120)}`;
        bids.forEach(bid => push.sendToUser(bid, { type: 'alert', notify: { title: `${label} · ЦУП`, body }, url: '/admin.html' }).catch(() => {}));
      }
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
// При переходе в 'done' (отработано) — уведомляем автора в Telegram и ЦУП (пуш).
router.put('/:id(\\d+)/status', requireAuth(['admin', 'superadmin']), express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const st = ['new', 'seen', 'done'].includes(req.body && req.body.status) ? req.body.status : 'seen';
    // Текущее состояние — чтобы уведомить автора ровно один раз, на переходе в done.
    const prev = await pool.query('SELECT status, user_id, kind, text FROM ticketsmodule_feedback WHERE id=$1', [id]);
    const fb = prev.rows[0];
    await pool.query('UPDATE ticketsmodule_feedback SET status=$1 WHERE id=$2', [st, id]);
    if (st === 'done' && fb && fb.status !== 'done') {
      notifyAuthorResolved(fb).catch(() => {}); // best-effort, не блокирует ответ
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/feedback/open — неотработанные обращения (new+seen), свежие сверху.
// Для режима «покажи неотработанные» (Claude/админка). Только админ/суперадмин.
router.get('/open', requireAuth(['admin', 'superadmin']), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, display_name, username, kind, page, module, text, status, created_at,
              (attachment_data IS NOT NULL) AS has_attachment
         FROM ticketsmodule_feedback WHERE status IN ('new','seen')
         ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ ok: true, count: rows.length, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

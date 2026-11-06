// Обратная связь сотрудников: «Предложить улучшение / Сообщить о проблеме».
// Кнопка на всех страницах → POST сюда → запись в БД + уведомление в Telegram/почту.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
let notif = null; try { notif = require('../notifications'); } catch (e) { /* уведомления опциональны */ }

const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

// POST /api/feedback — отправить идею/проблему. Любой авторизованный.
router.post('/', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const text = String(b.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'Напишите сообщение' });
    if (text.length > 4000) return res.status(400).json({ ok: false, error: 'Слишком длинно (макс. 4000 символов)' });
    const kind = b.kind === 'problem' ? 'problem' : 'idea';
    const page = String(b.page || '').slice(0, 300);
    const module = String(b.module || '').slice(0, 120);
    const u = req.user;
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_feedback (user_id, username, display_name, kind, page, module, text, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [u.id, u.username, u.display_name, kind, page, module, text, String(req.headers['user-agent'] || '').slice(0, 400)]
    );
    // Уведомление управленцам (не блокирует ответ).
    try {
      const who = u.display_name || u.username;
      const label = kind === 'problem' ? '🐞 Проблема' : '💡 Идея';
      const where = module || page || '—';
      if (notif && notif.tgMgt) notif.tgMgt(`${label} · ЦУП\nОт: ${who}\nМодуль: ${where}\n\n${text}`);
      if (notif && notif.sendEmail) notif.sendEmail(
        `ЦУП: ${label} от ${who}`,
        `<p><b>${label}</b> · ${esc(who)} · ${esc(where)}</p><pre style="white-space:pre-wrap;font:inherit">${esc(text)}</pre>`
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
      `SELECT id, user_id, display_name, username, kind, page, module, text, status, created_at
         FROM ticketsmodule_feedback ORDER BY created_at DESC LIMIT 300`
    );
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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

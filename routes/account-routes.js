// Личный кабинет: каждый вошедший пользователь видит и правит ТОЛЬКО себя.
// Разрешено: сменить отображаемое имя и пароль, настроить 2ФА (роуты /auth/*),
// привязать/отвязать Telegram, посмотреть свой журнал действий и лог уведомлений.
// Запрещено: создавать пользователей, менять роль/логин/почту/категории КП,
// деактивировать себя — этого здесь просто нет (только админ через /admin/*).
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { pool, auditLog, bcrypt, requireAuth } = require('../auth');

const MIN_PASSWORD_LENGTH = 8;

// Имя Telegram-бота для deep-link «/start <bitrixId>». Берём один раз через getMe.
let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  const token = process.env.TG_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = await r.json();
    if (d && d.ok && d.result && d.result.username) _botUsername = d.result.username;
  } catch (e) { /* best-effort */ }
  return _botUsername;
}

// GET /api/account/me — полный профиль себя (часть полей только для чтения).
router.get('/me', requireAuth(), async (req, res) => {
  try {
    const u = req.user;
    let telegram = { linked: false, username: null, linkedAt: null };
    if (u.bitrix_user_id) {
      const { rows } = await pool.query(
        'SELECT telegram_username, linked_at FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [u.bitrix_user_id]);
      if (rows.length) telegram = { linked: true, username: rows[0].telegram_username, linkedAt: rows[0].linked_at };
    }
    res.json({
      ok: true,
      user: {
        id: u.id, username: u.username, displayName: u.display_name, role: u.role,
        engineerName: u.engineer_name, mailMailbox: u.mail_mailbox || null,
        kpCategories: u.kp_categories || [], totpEnabled: !!u.totp_enabled,
        bitrixUserId: u.bitrix_user_id || null, createdAt: u.created_at,
      },
      telegram,
    });
  } catch (e) { console.error('account/me:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// PUT /api/account/profile — сменить ТОЛЬКО отображаемое имя.
router.put('/profile', requireAuth(), async (req, res) => {
  try {
    const displayName = (req.body.displayName || '').trim();
    if (displayName.length < 2) return res.status(400).json({ ok: false, error: 'Имя минимум 2 символа' });
    if (displayName.length > 200) return res.status(400).json({ ok: false, error: 'Слишком длинное имя' });
    await pool.query('UPDATE ticketsmodule_users SET display_name=$1, updated_at=NOW() WHERE id=$2', [displayName, req.user.id]);
    await auditLog(req.user.id, req.user.username, 'SELF_PROFILE_UPDATED', null, { displayName }, req.ip, req.headers['user-agent']);
    res.json({ ok: true, displayName });
  } catch (e) { console.error('account/profile:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// POST /api/account/password — сменить свой пароль (нужен текущий + новый).
router.post('/password', requireAuth(), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Заполните оба поля' });
    if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ ok: false, error: `Новый пароль минимум ${MIN_PASSWORD_LENGTH} символов` });
    }
    const { rows } = await pool.query('SELECT password_hash FROM ticketsmodule_users WHERE id=$1', [req.user.id]);
    const valid = rows.length && await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) {
      await auditLog(req.user.id, req.user.username, 'SELF_PASSWORD_FAIL', null, {}, req.ip, req.headers['user-agent']);
      return res.status(401).json({ ok: false, error: 'Текущий пароль неверен' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE ticketsmodule_users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
    await auditLog(req.user.id, req.user.username, 'SELF_PASSWORD_CHANGED', null, {}, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) { console.error('account/password:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// GET /api/account/logs — СВОЙ журнал действий (жёстко фильтр по своему user_id).
router.get('/logs', requireAuth(), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT id, action, ticket_id, details, ip, created_at
       FROM ticketsmodule_audit_logs WHERE user_id=$1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [req.user.id, limit, offset]);
    const cnt = await pool.query('SELECT COUNT(*) FROM ticketsmodule_audit_logs WHERE user_id=$1', [req.user.id]);
    res.json({ ok: true, logs: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch (e) { console.error('account/logs:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// GET /api/account/notifications — СВОЙ лог уведомлений (по своему bitrix_user_id).
router.get('/notifications', requireAuth(), async (req, res) => {
  try {
    if (!req.user.bitrix_user_id) return res.json({ ok: true, logs: [], total: 0, noBitrixLink: true });
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const r = await pool.query(
      `SELECT id, sent_at, bitrix_item_id, reason, channel, recipient_label, success, error
       FROM ticketsmodule_notification_log WHERE recipient_bitrix_id=$1
       ORDER BY sent_at DESC LIMIT $2 OFFSET $3`, [req.user.bitrix_user_id, limit, offset]);
    const cnt = await pool.query('SELECT COUNT(*) FROM ticketsmodule_notification_log WHERE recipient_bitrix_id=$1', [req.user.bitrix_user_id]);
    res.json({ ok: true, logs: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch (e) { console.error('account/notifications:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// GET /api/account/telegram — статус привязки Telegram.
// Подключение — только по одноразовой ссылке (POST /telegram/link-code): id сотрудника
// не секрет, поэтому старая ссылка «?start=<bitrix_id>» больше не работает.
router.get('/telegram', requireAuth(), async (req, res) => {
  try {
    await require('../tg-bot').ensure();
    const botUsername = await getBotUsername();
    const u = (await pool.query('SELECT telegram_chat_id, bitrix_user_id FROM ticketsmodule_users WHERE id=$1', [req.user.id])).rows[0] || {};
    let link = null;
    if (u.bitrix_user_id) link = (await pool.query('SELECT telegram_username, linked_at FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [u.bitrix_user_id])).rows[0] || null;
    res.json({
      ok: true, botUsername,
      linked: !!u.telegram_chat_id,                     // бот узнаёт и отвечает
      legacyOnly: !u.telegram_chat_id && !!link,        // привязан старым способом — только уведомления
      hasBitrixLink: !!u.bitrix_user_id,
      username: link ? link.telegram_username : null,
      linkedAt: link ? link.linked_at : null,
    });
  } catch (e) { console.error('account/telegram:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// POST /api/account/telegram/link-code — одноразовая ссылка на 15 минут.
router.post('/telegram/link-code', requireAuth(), async (req, res) => {
  try {
    const r = await require('../tg-bot').createLinkCode(req.user.id, 15);
    if (!r.url) return res.status(503).json({ ok: false, error: 'Бот не настроен (нет TG_TOKEN)' });
    res.json({ ok: true, url: r.url, ttlMin: r.ttlMin });
  } catch (e) { console.error('account/telegram/link-code:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// POST /api/account/telegram/unlink — отвязать свой Telegram (и бот, и уведомления).
router.post('/telegram/unlink', requireAuth(), async (req, res) => {
  try {
    await require('../tg-bot').unlinkUser(req.user);
    await auditLog(req.user.id, req.user.username, 'SELF_TELEGRAM_UNLINKED', null, {}, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) { console.error('account/telegram/unlink:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// ── Почта Google (OAuth, только чтение) — статус и отключение. Сами токены наружу не отдаются.
router.get('/google', requireAuth(), async (req, res) => {
  try { res.json({ ok: true, ...(await require('../gmail-lib').status(req.user.id)) }); }
  catch (e) { console.error('account/google:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});
router.post('/google/disconnect', requireAuth(), async (req, res) => {
  try {
    await require('../gmail-lib').disconnect(req.user.id);
    await auditLog(req.user.id, req.user.username, 'GOOGLE_MAIL_DISCONNECTED', null, {}, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) { console.error('account/google/disconnect:', e.message); res.status(500).json({ ok: false, error: 'Ошибка' }); }
});

// ── Личные настройки (ключ-значение): напр. флаг «видел онбординг-тур» ──
router.get('/prefs/:key', requireAuth(), async (req, res) => {
  try {
    const key = String(req.params.key || '').slice(0, 50);
    const { rows } = await pool.query('SELECT value FROM ticketsmodule_user_prefs WHERE user_id=$1 AND key=$2', [req.user.id, key]);
    res.json({ ok: true, key, value: rows.length ? rows[0].value : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/prefs/:key', requireAuth(), express.json(), async (req, res) => {
  try {
    const key = String(req.params.key || '').slice(0, 50);
    if (!key) return res.status(400).json({ ok: false, error: 'key required' });
    const value = (req.body && 'value' in req.body) ? req.body.value : null;
    await pool.query(
      `INSERT INTO ticketsmodule_user_prefs (user_id, key, value, updated_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value=$3, updated_at=NOW()`,
      [req.user.id, key, JSON.stringify(value)]
    );
    res.json({ ok: true, key, value });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;

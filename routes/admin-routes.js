const express = require('express');
const router = express.Router();
const { pool, auditLog, bcrypt, requireAuth } = require('../auth');
const { USERS, VALID_ROLES } = require('../constants');

const MIN_PASSWORD_LENGTH = 8;

function validateRole(role) {
  return VALID_ROLES.has(role);
}

function sanitizeError(e, res) {
  console.error('Admin route error:', e.message);
  res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
}

// GET /admin/tg-links
router.get('/tg-links', requireAuth(['admin']), async (req, res) => {
  try {
    const links = await pool.query(
      'SELECT bitrix_user_id, telegram_chat_id, linked_at FROM ticketsmodule_telegram_links'
    );
    const linkMap = {};
    for (const row of links.rows) linkMap[row.bitrix_user_id] = row;

    const users = Object.entries(USERS)
      .filter(([id]) => Number(id) > 10)
      .map(([id, name]) => ({
        id: Number(id), name,
        linked: !!linkMap[id],
        linkedAt: linkMap[id]?.linked_at || null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    res.json({ ok: true, users });
  } catch(e) { sanitizeError(e, res); }
});

// GET /admin/users
router.get('/users', requireAuth(['admin']), async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,username,display_name,role,totp_enabled,active,engineer_name,created_at FROM ticketsmodule_users ORDER BY created_at DESC'
    );
    res.json({ ok: true, users: r.rows });
  } catch(e) { sanitizeError(e, res); }
});

// POST /admin/users
router.post('/users', requireAuth(['admin']), async (req, res) => {
  try {
    const { username, displayName, password, role, engineerName } = req.body;

    if (!username || !password || !role) {
      return res.status(400).json({ ok: false, error: 'Заполните все обязательные поля' });
    }
    if (typeof username !== 'string' || username.trim().length < 3) {
      return res.status(400).json({ ok: false, error: 'Логин минимум 3 символа' });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ ok: false, error: `Пароль минимум ${MIN_PASSWORD_LENGTH} символов` });
    }
    if (!validateRole(role)) {
      return res.status(400).json({ ok: false, error: 'Недопустимая роль' });
    }

    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO ticketsmodule_users (username, display_name, password_hash, role, engineer_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [username.trim().toLowerCase(), (displayName || username).trim(), hash, role, engineerName || null]
    );
    await auditLog(req.user.id, req.user.username, 'USER_CREATED', null,
      { newUser: username, role }, req.ip, req.headers['user-agent']);
    res.json({ ok: true, userId: r.rows[0].id });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'Пользователь с таким логином уже существует' });
    sanitizeError(e, res);
  }
});

// PUT /admin/users/:id
router.put('/users/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const { displayName, role, active, engineerName, password } = req.body;
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'Неверный ID' });

    if (role && !validateRole(role)) {
      return res.status(400).json({ ok: false, error: 'Недопустимая роль' });
    }
    // Prevent removing last admin
    if (role && role !== 'admin') {
      const adminCount = await pool.query(
        "SELECT COUNT(*) FROM ticketsmodule_users WHERE role='admin' AND active=true AND id!=$1", [id]
      );
      if (parseInt(adminCount.rows[0].count) === 0) {
        return res.status(400).json({ ok: false, error: 'Нельзя убрать роль admin у последнего администратора' });
      }
    }
    if (password?.trim()) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ ok: false, error: `Пароль минимум ${MIN_PASSWORD_LENGTH} символов` });
      }
      const hash = await bcrypt.hash(password, 12);
      await pool.query('UPDATE ticketsmodule_users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, id]);
    }
    await pool.query(
      `UPDATE ticketsmodule_users SET display_name=$1, role=$2, active=$3, engineer_name=$4, updated_at=NOW() WHERE id=$5`,
      [(displayName||'').trim(), role, Boolean(active), engineerName||null, id]
    );
    await auditLog(req.user.id, req.user.username, 'USER_UPDATED', null,
      { targetId: id, role, active }, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch(e) { sanitizeError(e, res); }
});

// DELETE /admin/users/:id (soft delete)
router.delete('/users/:id', requireAuth(['admin']), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) return res.status(400).json({ ok: false, error: 'Нельзя деактивировать себя' });
    await pool.query('UPDATE ticketsmodule_users SET active=false, updated_at=NOW() WHERE id=$1', [id]);
    await auditLog(req.user.id, req.user.username, 'USER_DEACTIVATED', null, { targetId: id }, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch(e) { sanitizeError(e, res); }
});

// GET /admin/logs
router.get('/logs', requireAuth(['admin']), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const { userId, action, ticketId, search } = req.query;

    const conditions = [];
    const params = [];
    if (userId && /^\d+$/.test(userId)) { params.push(parseInt(userId)); conditions.push(`l.user_id=$${params.length}`); }
    if (action && /^[A-Z_]+$/.test(action)) { params.push(action); conditions.push(`l.action=$${params.length}`); }
    if (ticketId && /^\d+$/.test(ticketId)) { params.push(parseInt(ticketId)); conditions.push(`l.ticket_id=$${params.length}`); }
    if (search && search.length <= 100) { params.push(`%${search.replace(/[%_]/g, '\\$&')}%`); conditions.push(`(l.username ILIKE $${params.length} OR l.action ILIKE $${params.length})`); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(limit, offset);

    const r = await pool.query(
      `SELECT l.id, l.username, l.action, l.ticket_id, l.details, l.ip, l.created_at, u.display_name
       FROM ticketsmodule_audit_logs l
       LEFT JOIN ticketsmodule_users u ON l.user_id=u.id
       ${where} ORDER BY l.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    const cnt = await pool.query(`SELECT COUNT(*) FROM ticketsmodule_audit_logs l ${where}`, params.slice(0, -2));
    res.json({ ok: true, logs: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch(e) { sanitizeError(e, res); }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const { pool, auditLog, bcrypt, requireAuth } = require('../auth');

// GET /admin/users
router.get('/users', requireAuth(['admin']), async (req, res) => {
  const r = await pool.query(
    'SELECT id,username,display_name,role,totp_enabled,active,engineer_name,created_at,updated_at FROM ticketsmodule_users ORDER BY created_at DESC'
  );
  res.json({ ok: true, users: r.rows });
});

// POST /admin/users
router.post('/users', requireAuth(['admin']), async (req, res) => {
  const { username, displayName, password, role, engineerName } = req.body;
  if (!username || !password || !role) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      `INSERT INTO ticketsmodule_users (username, display_name, password_hash, role, engineer_name)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [username.trim(), displayName || username, hash, role, engineerName || null]
    );
    await auditLog(req.user.id, req.user.username, 'USER_CREATED', null,
      { newUser: username, role }, req.ip, req.headers['user-agent']);
    res.json({ ok: true, userId: r.rows[0].id });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ ok: false, error: 'Пользователь с таким логином уже существует' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PUT /admin/users/:id
router.put('/users/:id', requireAuth(['admin']), async (req, res) => {
  const { displayName, role, active, engineerName, password } = req.body;
  const id = parseInt(req.params.id);
  try {
    if (password?.trim()) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query('UPDATE ticketsmodule_users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, id]);
    }
    await pool.query(
      `UPDATE ticketsmodule_users SET display_name=$1, role=$2, active=$3, engineer_name=$4, updated_at=NOW() WHERE id=$5`,
      [displayName, role, active, engineerName || null, id]
    );
    await auditLog(req.user.id, req.user.username, 'USER_UPDATED', null,
      { targetId: id, role, active }, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /admin/users/:id (soft)
router.delete('/users/:id', requireAuth(['admin']), async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ ok: false, error: 'Нельзя деактивировать себя' });
  await pool.query('UPDATE ticketsmodule_users SET active=false, updated_at=NOW() WHERE id=$1', [id]);
  await auditLog(req.user.id, req.user.username, 'USER_DEACTIVATED', null, { targetId: id }, req.ip, req.headers['user-agent']);
  res.json({ ok: true });
});

// GET /admin/logs
router.get('/logs', requireAuth(['admin']), async (req, res) => {
  const { limit = 50, offset = 0, userId, action, ticketId, search } = req.query;
  const conditions = [];
  const params = [];

  if (userId) { params.push(parseInt(userId)); conditions.push(`l.user_id=$${params.length}`); }
  if (action) { params.push(action); conditions.push(`l.action=$${params.length}`); }
  if (ticketId) { params.push(parseInt(ticketId)); conditions.push(`l.ticket_id=$${params.length}`); }
  if (search) { params.push(`%${search}%`); conditions.push(`(l.username ILIKE $${params.length} OR l.action ILIKE $${params.length})`); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(parseInt(limit), parseInt(offset));

  const r = await pool.query(
    `SELECT l.*, u.display_name FROM ticketsmodule_audit_logs l
     LEFT JOIN ticketsmodule_users u ON l.user_id=u.id
     ${where} ORDER BY l.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
    params
  );
  const cnt = await pool.query(`SELECT COUNT(*) FROM ticketsmodule_audit_logs l ${where}`, params.slice(0,-2));
  res.json({ ok: true, logs: r.rows, total: parseInt(cnt.rows[0].count) });
});

module.exports = router;

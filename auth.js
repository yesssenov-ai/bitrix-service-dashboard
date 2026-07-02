const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'pls-tickets-jwt-2026';
const SESSION_HOURS = 8;

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      display_name VARCHAR(200) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'viewer',
      totp_secret VARCHAR(255),
      totp_enabled BOOLEAN DEFAULT false,
      active BOOLEAN DEFAULT true,
      engineer_name VARCHAR(200),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ticketsmodule_users(id) ON DELETE SET NULL,
      username VARCHAR(100),
      action VARCHAR(100) NOT NULL,
      ticket_id INTEGER,
      details JSONB DEFAULT '{}',
      ip VARCHAR(100),
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tm_audit_created ON ticketsmodule_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tm_audit_user ON ticketsmodule_audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_tm_audit_ticket ON ticketsmodule_audit_logs(ticket_id);

    CREATE TABLE IF NOT EXISTS ticketsmodule_telegram_links (
      id SERIAL PRIMARY KEY,
      bitrix_user_id INTEGER UNIQUE NOT NULL,
      telegram_chat_id BIGINT NOT NULL,
      telegram_username VARCHAR(200),
      linked_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_notified_overdue (
      ticket_id INTEGER PRIMARY KEY,
      notified_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Create default admin if no users exist
  const count = await pool.query('SELECT COUNT(*) FROM ticketsmodule_users');
  if (parseInt(count.rows[0].count) === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 12);
    await pool.query(
      `INSERT INTO ticketsmodule_users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')`,
      [process.env.ADMIN_USERNAME || 'admin', 'Администратор', hash]
    );
    console.log('✅ Default admin created');
  }
  console.log('✅ ticketsmodule DB ready');
}

async function auditLog(userId, username, action, ticketId, details, ip, userAgent) {
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_audit_logs (user_id, username, action, ticket_id, details, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId || null, username || null, action, ticketId || null,
       JSON.stringify(details || {}), ip || null, userAgent || null]
    );
  } catch(e) { console.error('Audit log error:', e.message); }
}

function requireAuth(roles = []) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ ok: false, error: 'Не авторизован', redirect: '/login' });

      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.step) return res.status(401).json({ ok: false, error: 'Требуется 2FA', redirect: '/login' });

      const result = await pool.query(
        'SELECT * FROM ticketsmodule_users WHERE id=$1 AND active=true', [payload.userId]
      );
      if (!result.rows.length) return res.status(401).json({ ok: false, error: 'Пользователь не найден', redirect: '/login' });

      const user = result.rows[0];
      if (roles.length && !roles.includes(user.role)) {
        return res.status(403).json({ ok: false, error: 'Недостаточно прав' });
      }
      req.user = user;
      next();
    } catch(e) {
      res.status(401).json({ ok: false, error: 'Сессия истекла', redirect: '/login' });
    }
  };
}

function canEdit(user, ticket) {
  if (['admin', 'coordinator'].includes(user.role)) return true;
  if (user.role === 'engineer' && user.engineer_name) {
    return ticket?.engineer === user.engineer_name;
  }
  return false;
}

module.exports = { pool, initDB, auditLog, requireAuth, canEdit, bcrypt, jwt, speakeasy, JWT_SECRET, SESSION_HOURS };

// Equipment map cache table - added to initDB separately
async function initEquipmentMapDB(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_equipment_geo (
      item_id INTEGER PRIMARY KEY,
      address TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      geocoded_at TIMESTAMPTZ DEFAULT NOW(),
      geocode_failed BOOLEAN DEFAULT false
    );
  `);
}

module.exports.initEquipmentMapDB = initEquipmentMapDB;

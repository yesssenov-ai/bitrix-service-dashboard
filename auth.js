const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const speakeasy = require('speakeasy');
const { Pool } = require('pg');
const { VALID_ROLES } = require('./constants');

// ── Validate required env vars at startup ────────────────────────────────────
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_HOURS = 8;

// ── DB Init ───────────────────────────────────────────────────────────────────
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

    CREATE TABLE IF NOT EXISTS ticketsmodule_equipment_geo (
      item_id INTEGER PRIMARY KEY,
      address TEXT,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      geocoded_at TIMESTAMPTZ DEFAULT NOW(),
      geocode_failed BOOLEAN DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_equipment_cache (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      device_names JSONB DEFAULT '{}',
      built_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_login_attempts (
      ip VARCHAR(100) NOT NULL,
      attempted_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tm_login_ip ON ticketsmodule_login_attempts(ip, attempted_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tm_audit_created ON ticketsmodule_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tm_audit_user ON ticketsmodule_audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_tm_audit_ticket ON ticketsmodule_audit_logs(ticket_id);
  `);

  // Create default admin if none exists
  const count = await pool.query('SELECT COUNT(*) FROM ticketsmodule_users');
  if (parseInt(count.rows[0].count) === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query(
      `INSERT INTO ticketsmodule_users (username, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')`,
      [process.env.ADMIN_USERNAME, 'Администратор', hash]
    );
    console.log('✅ Default admin created');
  }
  console.log('✅ ticketsmodule DB ready');
}

// ── Audit log ─────────────────────────────────────────────────────────────────
async function auditLog(userId, username, action, ticketId, details, ip, userAgent) {
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_audit_logs (user_id, username, action, ticket_id, details, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId||null, username||null, action, ticketId||null,
       JSON.stringify(details||{}), ip||null, userAgent||null]
    );
  } catch(e) { console.error('Audit log error:', e.message); }
}

// ── Brute force protection ────────────────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

async function checkLoginRateLimit(ip) {
  try {
    const since = new Date(Date.now() - WINDOW_MS);
    const result = await pool.query(
      'SELECT COUNT(*) FROM ticketsmodule_login_attempts WHERE ip=$1 AND attempted_at > $2',
      [ip, since]
    );
    return parseInt(result.rows[0].count) >= MAX_ATTEMPTS;
  } catch(e) { return false; }
}

async function recordLoginAttempt(ip) {
  try {
    await pool.query('INSERT INTO ticketsmodule_login_attempts (ip) VALUES ($1)', [ip]);
    // Clean old attempts
    await pool.query('DELETE FROM ticketsmodule_login_attempts WHERE attempted_at < NOW() - INTERVAL \'1 hour\'');
  } catch(e) {}
}

async function clearLoginAttempts(ip) {
  try {
    await pool.query('DELETE FROM ticketsmodule_login_attempts WHERE ip=$1', [ip]);
  } catch(e) {}
}

// ── JWT token blacklist (for logout invalidation) ─────────────────────────────
const tokenBlacklist = new Set();

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(roles = []) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
      if (!token) return res.status(401).json({ ok: false, error: 'Не авторизован', redirect: '/login' });
      if (tokenBlacklist.has(token)) return res.status(401).json({ ok: false, error: 'Сессия завершена', redirect: '/login' });

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
      req.token = token;
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

// ── Equipment map DB init (kept in same initDB now) ───────────────────────────
async function initEquipmentMapDB() {} // no-op, table created in initDB above

module.exports = {
  pool, initDB, initEquipmentMapDB, auditLog, requireAuth, canEdit,
  checkLoginRateLimit, recordLoginAttempt, clearLoginAttempts, tokenBlacklist,
  bcrypt, jwt, speakeasy, JWT_SECRET, SESSION_HOURS, VALID_ROLES,
};

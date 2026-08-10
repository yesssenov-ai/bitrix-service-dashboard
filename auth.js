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

    CREATE TABLE IF NOT EXISTS ticketsmodule_planner_events (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL,
      resource VARCHAR(200) NOT NULL,
      title VARCHAR(500) DEFAULT '',
      type VARCHAR(20) NOT NULL DEFAULT 'trip',
      start_at TIMESTAMPTZ NOT NULL,
      end_at TIMESTAMPTZ NOT NULL,
      all_day BOOLEAN DEFAULT false,
      confirmed BOOLEAN DEFAULT false,
      note TEXT DEFAULT '',
      fields JSONB DEFAULT '{}',
      clients JSONB DEFAULT '[]',
      bitrix_item_id INTEGER,
      bitrix_sync_hash VARCHAR(64),
      source VARCHAR(20) NOT NULL DEFAULT 'manual',
      created_by VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tm_planner_ev_resource ON ticketsmodule_planner_events(resource);
    CREATE INDEX IF NOT EXISTS idx_tm_planner_ev_bitrix ON ticketsmodule_planner_events(bitrix_item_id);
    CREATE INDEX IF NOT EXISTS idx_tm_planner_ev_group ON ticketsmodule_planner_events(group_id);

    CREATE TABLE IF NOT EXISTS ticketsmodule_planner_datafields (
      id VARCHAR(20) PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      type VARCHAR(20) NOT NULL,
      options JSONB DEFAULT '[]',
      required BOOLEAN DEFAULT false,
      sort_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_planner_config (
      key VARCHAR(50) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_module_access (
      bitrix_user_id INTEGER PRIMARY KEY,
      modules JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_user_prefs (
      user_id INTEGER NOT NULL,
      key VARCHAR(50) NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_notification_log (
      id SERIAL PRIMARY KEY,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      bitrix_item_id INTEGER,
      reason VARCHAR(100),
      channel VARCHAR(20) NOT NULL,
      recipient_bitrix_id INTEGER,
      recipient_label VARCHAR(300),
      success BOOLEAN NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tm_notiflog_sent ON ticketsmodule_notification_log(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tm_notiflog_item ON ticketsmodule_notification_log(bitrix_item_id);

    -- ── КП (Коммерческие предложения) module ──────────────────────────────
    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_catalog_versions (
      id SERIAL PRIMARY KEY,
      uploaded_by INTEGER,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      filename VARCHAR(300),
      active BOOLEAN DEFAULT false,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_categories (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(200) NOT NULL,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_items (
      id SERIAL PRIMARY KEY,
      stable_key VARCHAR(64) NOT NULL,
      catalog_version_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_catalog_versions(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_categories(id),
      section_name VARCHAR(300),
      item_no VARCHAR(500),
      name TEXT NOT NULL,
      unit_price NUMERIC(14,2),
      is_included BOOLEAN DEFAULT false,
      specs TEXT,
      power_kw VARCHAR(50),
      sort_order INTEGER,
      UNIQUE(catalog_version_id, stable_key)
    );
    CREATE INDEX IF NOT EXISTS idx_tm_kp_items_version ON ticketsmodule_kp_items(catalog_version_id);
    CREATE INDEX IF NOT EXISTS idx_tm_kp_items_stable ON ticketsmodule_kp_items(stable_key);

    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_requests (
      id SERIAL PRIMARY KEY,
      client_name VARCHAR(300) NOT NULL,
      created_by INTEGER,
      pm_id INTEGER,
      catalog_version_id INTEGER REFERENCES ticketsmodule_kp_catalog_versions(id),
      status VARCHAR(30) NOT NULL DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_request_categories (
      id SERIAL PRIMARY KEY,
      kp_request_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_requests(id) ON DELETE CASCADE,
      category_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_categories(id),
      expert_id INTEGER,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      saved_at TIMESTAMPTZ,
      UNIQUE(kp_request_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_line_items (
      id SERIAL PRIMARY KEY,
      kp_request_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_requests(id) ON DELETE CASCADE,
      item_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_items(id),
      quantity NUMERIC(10,2) NOT NULL,
      unit_price_snapshot NUMERIC(14,2),
      is_included_snapshot BOOLEAN DEFAULT false,
      UNIQUE(kp_request_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_kp_comments (
      id SERIAL PRIMARY KEY,
      kp_request_id INTEGER NOT NULL REFERENCES ticketsmodule_kp_requests(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES ticketsmodule_kp_categories(id),
      author_id INTEGER,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tm_kp_req_categories ON ticketsmodule_kp_request_categories(kp_request_id);
    CREATE INDEX IF NOT EXISTS idx_tm_kp_line_items_req ON ticketsmodule_kp_line_items(kp_request_id);
    CREATE INDEX IF NOT EXISTS idx_tm_kp_comments_req ON ticketsmodule_kp_comments(kp_request_id);

    ALTER TABLE ticketsmodule_users ADD COLUMN IF NOT EXISTS kp_categories JSONB DEFAULT '[]';

    -- ── Статистика module ────────────────────────────────────────────────────
    -- Bitrix's "Производитель" field on deals is an iblock_element field
    -- that turned out unresolvable via REST (returns raw internal IDs that
    -- don't correspond 1:1 with any single manufacturer — confirmed via
    -- extensive testing). Instead, we key off UF_CRM_NAME_PRIOBOR (a plain
    -- reliable text field with the specific instrument name) and look up
    -- its manufacturer here — same pattern as the bonus module's tariff
    -- category mapping, built from a verified Bitrix export.
    CREATE TABLE IF NOT EXISTS ticketsmodule_stat_instrument_manufacturer (
      instrument_name VARCHAR(300) PRIMARY KEY,
      manufacturer VARCHAR(200) NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Local mirror of relevant deal fields for the Статистика module. Kept
    -- in sync via webhooks (ONCRMDEALADD/ONCRMDEALUPDATE) plus a periodic
    -- full reconciliation as a safety net — avoids scanning all of Bitrix
    -- live every time someone opens the dashboard.
    CREATE TABLE IF NOT EXISTS ticketsmodule_stat_deals (
      deal_id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL,
      stage_id VARCHAR(60),
      deal_type_id VARCHAR(60),
      deal_title TEXT,
      opportunity NUMERIC(16,2),
      currency_id VARCHAR(10),
      company_id INTEGER,
      assigned_by_id INTEGER,
      contract_date DATE,
      instrument_name VARCHAR(300),
      department_id VARCHAR(60),
      manufacturer VARCHAR(200),
      industry VARCHAR(200),
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE ticketsmodule_stat_deals ADD COLUMN IF NOT EXISTS deal_type_id VARCHAR(60);
    ALTER TABLE ticketsmodule_stat_deals ADD COLUMN IF NOT EXISTS deal_title TEXT;

    -- ── Переписка с клиентом по заявке (Написать клиенту) ───────────────────
    -- Each engineer stores their own Yandex 360 app password (encrypted) so
    -- outgoing mail can be sent as their real corporate address via SMTP.
    ALTER TABLE ticketsmodule_users ADD COLUMN IF NOT EXISTS smtp_app_password_encrypted TEXT;
    -- Per-employee signature fields (name comes from display_name; office
    -- phone and address are fixed company-wide, set directly in the template).
    ALTER TABLE ticketsmodule_users ADD COLUMN IF NOT EXISTS job_title VARCHAR(200);
    ALTER TABLE ticketsmodule_users ADD COLUMN IF NOT EXISTS mobile_phone VARCHAR(50);

    CREATE TABLE IF NOT EXISTS ticketsmodule_ticket_emails (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL,
      direction VARCHAR(10) NOT NULL, -- 'sent' | 'received'
      from_address VARCHAR(255),
      to_address VARCHAR(255),
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      sender_user_id INTEGER REFERENCES ticketsmodule_users(id),
      message_id VARCHAR(255),
      references_header TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE ticketsmodule_ticket_emails ADD COLUMN IF NOT EXISTS references_header TEXT;
    CREATE INDEX IF NOT EXISTS idx_ticket_emails_ticket ON ticketsmodule_ticket_emails(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_stat_deals_category ON ticketsmodule_stat_deals(category_id);
    CREATE INDEX IF NOT EXISTS idx_stat_deals_contract_date ON ticketsmodule_stat_deals(contract_date);
    CREATE INDEX IF NOT EXISTS idx_stat_deals_stage ON ticketsmodule_stat_deals(stage_id);

    -- ── Операционный модуль «Реализация» ──────────────────────────────────────
    -- Local cache of execution-phase deals (contract → завершена, all 4
    -- pipelines). Kept fresh three ways: the ONCRMDEALADD/UPDATE webhook
    -- (per-deal), a nightly full sync, and a manual "Обновить" button — so the
    -- board loads instantly from Postgres instead of scanning Bitrix live.
    CREATE TABLE IF NOT EXISTS ticketsmodule_operational_deals (
      deal_id INTEGER PRIMARY KEY,
      category_id INTEGER NOT NULL,
      stage_id VARCHAR(60),
      stage_semantic VARCHAR(4),          -- P (в работе) / S (успех) / F (провал)
      opportunity NUMERIC(16,2),
      currency_id VARCHAR(10),
      assigned_by_id INTEGER,             -- менеджер сделки
      department_id VARCHAR(60),
      deal_title TEXT,
      company_id INTEGER,
      company_name TEXT,
      contract_no TEXT,
      contract_date DATE,
      delivery_by_date DATE,              -- Срок поставки по договору
      factory_ship_date DATE,             -- Срок поставки от завода
      pay_factory TEXT,                   -- Условия оплаты поставщикам (label)
      pay_client TEXT,                    -- Условия оплаты от клиента (label)
      engineer_id INTEGER,
      comment TEXT,
      red_flag BOOLEAN DEFAULT false,
      open_processes INTEGER DEFAULT 0,   -- дочерние смарт-процессы не в финале
      overdue_tasks INTEGER DEFAULT 0,
      total_tasks INTEGER DEFAULT 0,
      date_modify TIMESTAMPTZ,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_op_deals_category ON ticketsmodule_operational_deals(category_id);
    CREATE INDEX IF NOT EXISTS idx_op_deals_stage ON ticketsmodule_operational_deals(stage_id);
    -- Активные (незавершённые) бизнес-процессы автоматизации на сделке + её смартах.
    ALTER TABLE ticketsmodule_operational_deals ADD COLUMN IF NOT EXISTS open_bp INTEGER DEFAULT 0;

    -- Кэш раскрытия сделки (смарт-процессы/задачи/комментарии/БП). Строится
    -- лениво при первом открытии, отдаётся мгновенно из БД, обновляется по
    -- кнопке «↻ Обновить» и сбрасывается вебхуком при изменении сделки.
    CREATE TABLE IF NOT EXISTS ticketsmodule_operational_detail (
      deal_id INTEGER PRIMARY KEY,
      detail JSONB NOT NULL,
      synced_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_operational_meta (
      id INTEGER PRIMARY KEY DEFAULT 1,
      last_full_sync TIMESTAMPTZ,
      deal_count INTEGER DEFAULT 0,
      last_source VARCHAR(20)
    );

    ALTER TABLE ticketsmodule_kp_items ALTER COLUMN item_no TYPE VARCHAR(500);

    -- ── Бонусы инженеров module ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS ticketsmodule_exchange_rates (
      rate_date DATE PRIMARY KEY,
      rate NUMERIC(10,4) NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_bonus_tariff_categories (
      id SERIAL PRIMARY KEY,
      slug VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(200) NOT NULL,
      install_usd NUMERIC(10,2),
      methodical_usd NUMERIC(10,2)
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_instrument_category_map (
      id SERIAL PRIMARY KEY,
      bitrix_pribor_id INTEGER UNIQUE NOT NULL,
      pribor_name TEXT NOT NULL,
      category_id INTEGER REFERENCES ticketsmodule_bonus_tariff_categories(id),
      install_usd NUMERIC(10,2),
      methodical_usd NUMERIC(10,2)
    );
    -- Per-instrument tariff amounts (filled from instrumentsexport.xlsx). These
    -- take precedence over the category-level amounts when present.
    ALTER TABLE ticketsmodule_instrument_category_map ADD COLUMN IF NOT EXISTS install_usd NUMERIC(10,2);
    ALTER TABLE ticketsmodule_instrument_category_map ADD COLUMN IF NOT EXISTS methodical_usd NUMERIC(10,2);
    CREATE INDEX IF NOT EXISTS idx_tm_instr_cat_map_pribor ON ticketsmodule_instrument_category_map(bitrix_pribor_id);

    CREATE TABLE IF NOT EXISTS ticketsmodule_mail_emails (
      id TEXT PRIMARY KEY,
      message_id TEXT UNIQUE,
      in_reply_to TEXT,
      from_addr TEXT NOT NULL,
      from_name TEXT,
      subject TEXT,
      received_at TIMESTAMPTZ NOT NULL,
      category TEXT DEFAULT 'uncategorized',
      category_source TEXT DEFAULT 'manual',
      answered INTEGER DEFAULT 0,
      answered_at TIMESTAMPTZ,
      answered_by TEXT,
      answer_body TEXT,
      answer_subject TEXT,
      notified INTEGER DEFAULT 0,
      body_preview TEXT,
      mailbox TEXT DEFAULT 'service'
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_mail_rules (
      id SERIAL PRIMARY KEY,
      field TEXT NOT NULL,
      pattern TEXT NOT NULL,
      category TEXT NOT NULL,
      hit_count INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ticketsmodule_mail_learned_patterns (
      id SERIAL PRIMARY KEY,
      pattern TEXT NOT NULL,
      field TEXT NOT NULL,
      category TEXT NOT NULL,
      confidence INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(pattern, field)
    );

    CREATE INDEX IF NOT EXISTS idx_tm_mail_received ON ticketsmodule_mail_emails(received_at);
    CREATE INDEX IF NOT EXISTS idx_tm_mail_answered ON ticketsmodule_mail_emails(answered);
    CREATE INDEX IF NOT EXISTS idx_tm_mail_category ON ticketsmodule_mail_emails(category);
    CREATE INDEX IF NOT EXISTS idx_tm_mail_msgid ON ticketsmodule_mail_emails(message_id);
    CREATE INDEX IF NOT EXISTS idx_tm_mail_mailbox ON ticketsmodule_mail_emails(mailbox);

    ALTER TABLE ticketsmodule_users ADD COLUMN IF NOT EXISTS mail_mailbox VARCHAR(20);

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

  // Seed default mail classification rules if none exist yet
  const ruleCount = await pool.query('SELECT COUNT(*) FROM ticketsmodule_mail_rules');
  if (parseInt(ruleCount.rows[0].count) === 0) {
    const defaultRules = [
      ['subject', 'тендер', 'tender'], ['subject', 'закупк', 'tender'], ['subject', 'конкурс', 'tender'],
      ['from', 'zakupki.gov', 'tender'], ['from', 'samruk', 'tender'],
      ['subject', 'предложение о сотрудничестве', 'adv'], ['subject', 'реклам', 'adv'],
      ['subject', 'прайс-лист', 'adv'], ['subject', 'акция', 'adv'], ['subject', 'скидк', 'adv'],
      ['from', 'noreply', 'spam'], ['from', 'no-reply', 'spam'], ['from', 'newsletter', 'spam'],
      ['subject', '[spam]', 'spam'], ['from', 'e-tender', 'tender'], ['from', 'tender', 'tender'],
    ];
    for (const [field, pattern, category] of defaultRules) {
      await pool.query(
        'INSERT INTO ticketsmodule_mail_rules (field, pattern, category) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [field, pattern, category]
      );
    }
    console.log('✅ Default mail classification rules created');
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

function requirePageAuth(roles = []) {
  return async (req, res, next) => {
    try {
      const token = req.cookies?.token;
      if (!token) return res.redirect('/login.html');
      if (tokenBlacklist.has(token)) return res.redirect('/login.html');
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.step) return res.redirect('/login.html');
      const result = await pool.query('SELECT * FROM ticketsmodule_users WHERE id=$1 AND active=true', [payload.userId]);
      if (!result.rows.length) return res.redirect('/login.html');
      const user = result.rows[0];
      if (roles.length && !roles.includes(user.role)) return res.redirect('/');
      req.user = user;
      next();
    } catch (e) {
      res.redirect('/login.html');
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
  pool, initDB, initEquipmentMapDB, auditLog, requireAuth, requirePageAuth, canEdit,
  checkLoginRateLimit, recordLoginAttempt, clearLoginAttempts, tokenBlacklist,
  bcrypt, jwt, speakeasy, JWT_SECRET, SESSION_HOURS, VALID_ROLES,
};

const express = require('express');
const router = express.Router();
const {
  pool, auditLog, bcrypt, jwt, speakeasy, JWT_SECRET, SESSION_HOURS, requireAuth,
  checkLoginRateLimit, recordLoginAttempt, clearLoginAttempts, tokenBlacklist,
} = require('../auth');

const COOKIE_OPTS = (maxAge) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge,
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const ua = req.headers['user-agent'];

  // Basic input validation
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ ok: false, error: 'Введите логин и пароль' });
  }

  // Rate limit check
  const blocked = await checkLoginRateLimit(ip);
  if (blocked) {
    return res.status(429).json({ ok: false, error: 'Слишком много попыток. Попробуйте через 15 минут' });
  }

  try {
    const r = await pool.query(
      'SELECT * FROM ticketsmodule_users WHERE username=$1 AND active=true',
      [username.trim().toLowerCase()]
    );

    if (!r.rows.length) {
      await recordLoginAttempt(ip);
      await auditLog(null, username, 'LOGIN_FAIL', null, { reason: 'not_found' }, ip, ua);
      return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
    }

    const user = r.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await recordLoginAttempt(ip);
      await auditLog(user.id, username, 'LOGIN_FAIL', null, { reason: 'wrong_password' }, ip, ua);
      return res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
    }

    // Success — clear failed attempts
    await clearLoginAttempts(ip);

    if (user.totp_enabled) {
      const temp = jwt.sign({ userId: user.id, step: 'totp' }, JWT_SECRET, { expiresIn: '5m' });
      return res.json({ ok: true, requireTotp: true, tempToken: temp, displayName: user.display_name });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
    res.cookie('token', token, COOKIE_OPTS(SESSION_HOURS * 3600000));
    await auditLog(user.id, user.username, 'LOGIN_SUCCESS', null, {}, ip, ua);
    res.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, engineerName: user.engineer_name } });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});

// POST /auth/totp
router.post('/totp', async (req, res) => {
  const { tempToken, code } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const ua = req.headers['user-agent'];

  if (!tempToken || !code) return res.status(400).json({ ok: false, error: 'Неверный запрос' });

  // Rate limit TOTP attempts too
  const blocked = await checkLoginRateLimit(ip + ':totp');
  if (blocked) return res.status(429).json({ ok: false, error: 'Слишком много попыток' });

  try {
    const payload = jwt.verify(tempToken, JWT_SECRET);
    if (payload.step !== 'totp') return res.status(401).json({ ok: false, error: 'Неверный токен' });

    const r = await pool.query('SELECT * FROM ticketsmodule_users WHERE id=$1 AND active=true', [payload.userId]);
    if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Пользователь не найден' });
    const user = r.rows[0];

    const ok = speakeasy.totp.verify({
      secret: user.totp_secret, encoding: 'base32',
      token: String(code).replace(/\s/g, ''), window: 2,
    });

    if (!ok) {
      await recordLoginAttempt(ip + ':totp');
      await auditLog(user.id, user.username, 'TOTP_FAIL', null, {}, ip, ua);
      return res.status(401).json({ ok: false, error: 'Неверный код. Попробуйте ещё раз' });
    }

    await clearLoginAttempts(ip + ':totp');
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
    res.cookie('token', token, COOKIE_OPTS(SESSION_HOURS * 3600000));
    await auditLog(user.id, user.username, 'LOGIN_2FA_SUCCESS', null, {}, ip, ua);
    res.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, engineerName: user.engineer_name } });
  } catch(e) {
    res.status(401).json({ ok: false, error: 'Сессия истекла, войдите заново' });
  }
});

// POST /auth/logout — invalidate token
router.post('/logout', requireAuth(), async (req, res) => {
  tokenBlacklist.add(req.token);
  // Auto-clean blacklist after token expiry (8h)
  setTimeout(() => tokenBlacklist.delete(req.token), SESSION_HOURS * 3600000);
  await auditLog(req.user.id, req.user.username, 'LOGOUT', null, {},
    req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
  res.clearCookie('token');
  res.json({ ok: true });
});

// GET /auth/me
router.get('/me', requireAuth(), (req, res) => {
  const u = req.user;
  res.json({ ok: true, user: { id: u.id, username: u.username, displayName: u.display_name, role: u.role, engineerName: u.engineer_name, totpEnabled: u.totp_enabled } });
});

// POST /auth/setup-totp
router.post('/setup-totp', requireAuth(), async (req, res) => {
  const secret = speakeasy.generateSecret({ name: `ProLab Service (${req.user.username})`, issuer: 'ProLabSupport', length: 20 });
  await pool.query('UPDATE ticketsmodule_users SET totp_secret=$1, totp_enabled=false, updated_at=NOW() WHERE id=$2', [secret.base32, req.user.id]);
  const qrcode = require('qrcode');
  const qr = await qrcode.toDataURL(secret.otpauth_url);
  res.json({ ok: true, secret: secret.base32, qr });
});

// POST /auth/confirm-totp
router.post('/confirm-totp', requireAuth(), async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ ok: false, error: 'Введите код' });
  const r = await pool.query('SELECT totp_secret FROM ticketsmodule_users WHERE id=$1', [req.user.id]);
  const verified = speakeasy.totp.verify({
    secret: r.rows[0].totp_secret, encoding: 'base32',
    token: String(code).replace(/\s/g, ''), window: 2,
  });
  if (!verified) return res.status(400).json({ ok: false, error: 'Неверный код' });
  await pool.query('UPDATE ticketsmodule_users SET totp_enabled=true, updated_at=NOW() WHERE id=$1', [req.user.id]);
  await auditLog(req.user.id, req.user.username, 'TOTP_ENABLED', null, {}, req.ip, req.headers['user-agent']);
  res.json({ ok: true });
});

module.exports = router;

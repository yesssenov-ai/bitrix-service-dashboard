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

// «Запомнить на N дней»: если пользователь выбрал 5/15/30 — выдаём длинную сессию,
// и в течение этого срока вход не спрашивает ни пароль, ни 2ФА, ни Face ID.
// Иначе — обычная короткая сессия SESSION_HOURS.
const REMEMBER_DAYS = new Set([5, 15, 30]);
function sessionSpec(rememberDays) {
  const d = parseInt(rememberDays, 10);
  if (REMEMBER_DAYS.has(d)) return { expiresIn: `${d}d`, maxAge: d * 86400000 };
  return { expiresIn: `${SESSION_HOURS}h`, maxAge: SESSION_HOURS * 3600000 };
}

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

    // 2FA is mandatory — reuse an in-progress secret if this user already
    // started setup before (so a QR they'd already scanned keeps working),
    // otherwise generate a fresh one.
    let secretBase32 = user.totp_secret;
    if (!secretBase32) {
      const secret = speakeasy.generateSecret({ name: `ProLab Service (${user.username})`, issuer: 'ProLabSupport', length: 20 });
      secretBase32 = secret.base32;
      await pool.query('UPDATE ticketsmodule_users SET totp_secret=$1, updated_at=NOW() WHERE id=$2', [secretBase32, user.id]);
    }
    const otpauthUrl = speakeasy.otpauthURL({ secret: secretBase32, label: `ProLab Service (${user.username})`, issuer: 'ProLabSupport', encoding: 'base32' });
    const qrcode = require('qrcode');
    const qr = await qrcode.toDataURL(otpauthUrl);
    const setupToken = jwt.sign({ userId: user.id, step: 'setup' }, JWT_SECRET, { expiresIn: '10m' });
    await auditLog(user.id, user.username, 'LOGIN_REQUIRES_2FA_SETUP', null, {}, ip, ua);
    return res.json({ ok: true, requireSetup: true, tempToken: setupToken, displayName: user.display_name, qr, secret: secretBase32 });
  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});

// POST /auth/setup-confirm — completes MANDATORY first-time 2FA enrollment
// (uses the short-lived setup token from /auth/login, not a full session,
// since a user without 2FA configured can't have one yet).
router.post('/setup-confirm', async (req, res) => {
  const { tempToken, code } = req.body;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const ua = req.headers['user-agent'];

  if (!tempToken || !code) return res.status(400).json({ ok: false, error: 'Неверный запрос' });

  const blocked = await checkLoginRateLimit(ip + ':setup');
  if (blocked) return res.status(429).json({ ok: false, error: 'Слишком много попыток' });

  try {
    const payload = jwt.verify(tempToken, JWT_SECRET);
    if (payload.step !== 'setup') return res.status(401).json({ ok: false, error: 'Неверный токен' });

    const r = await pool.query('SELECT * FROM ticketsmodule_users WHERE id=$1 AND active=true', [payload.userId]);
    if (!r.rows.length) return res.status(401).json({ ok: false, error: 'Пользователь не найден' });
    const user = r.rows[0];

    const ok = speakeasy.totp.verify({
      secret: user.totp_secret, encoding: 'base32',
      token: String(code).replace(/\s/g, ''), window: 2,
    });
    if (!ok) {
      await recordLoginAttempt(ip + ':setup');
      await auditLog(user.id, user.username, 'TOTP_SETUP_FAIL', null, {}, ip, ua);
      return res.status(401).json({ ok: false, error: 'Неверный код. Попробуйте ещё раз' });
    }

    await clearLoginAttempts(ip + ':setup');
    await pool.query('UPDATE ticketsmodule_users SET totp_enabled=true, updated_at=NOW() WHERE id=$1', [user.id]);
    const spec = sessionSpec((req.body || {}).rememberDays);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: spec.expiresIn });
    res.cookie('token', token, COOKIE_OPTS(spec.maxAge));
    await auditLog(user.id, user.username, 'TOTP_ENABLED', null, {}, ip, ua);
    await auditLog(user.id, user.username, 'LOGIN_SUCCESS', null, {}, ip, ua);
    res.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, engineerName: user.engineer_name } });
  } catch(e) {
    res.status(401).json({ ok: false, error: 'Сессия истекла, войдите заново' });
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
    const spec = sessionSpec((req.body || {}).rememberDays);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: spec.expiresIn });
    res.cookie('token', token, COOKIE_OPTS(spec.maxAge));
    await auditLog(user.id, user.username, 'LOGIN_2FA_SUCCESS', null, { rememberDays: spec.maxAge / 86400000 }, ip, ua);
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

// ── Вход по Face ID / Touch ID / Windows Hello (WebAuthn passkeys) ───────────
// Челлендж между «options» и «verify» храним в коротком подписанном cookie (5 мин).
const WA_CHAL_COOKIE = 'wa_chal';
const waChalOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 5 * 60 * 1000 };
function setChallenge(res, data) {
  const t = jwt.sign(data, JWT_SECRET, { expiresIn: '5m' });
  res.cookie(WA_CHAL_COOKIE, t, waChalOpts);
}
function readChallenge(req) {
  try { return jwt.verify(req.cookies?.[WA_CHAL_COOKIE] || '', JWT_SECRET); } catch (e) { return null; }
}

// Включение Face ID — только для вошедшего пользователя.
router.post('/webauthn/register/options', requireAuth(), async (req, res) => {
  try {
    const wa = require('../webauthn');
    const options = await wa.registrationOptions(req, req.user);
    setChallenge(res, { c: options.challenge, uid: req.user.id, t: 'reg' });
    res.json(options);
  } catch (e) {
    console.error('webauthn register/options:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось начать регистрацию Face ID' });
  }
});

router.post('/webauthn/register/verify', requireAuth(), async (req, res) => {
  try {
    const wa = require('../webauthn');
    const ch = readChallenge(req);
    if (!ch || ch.t !== 'reg' || String(ch.uid) !== String(req.user.id)) {
      return res.status(400).json({ ok: false, error: 'Сессия регистрации истекла, попробуйте снова' });
    }
    const { response, label } = req.body || {};
    const r = await wa.verifyRegistration(req, req.user, response, ch.c, label);
    res.clearCookie(WA_CHAL_COOKIE);
    if (!r.verified) return res.status(400).json({ ok: false, error: 'Не удалось подтвердить Face ID' });
    await auditLog(req.user.id, req.user.username, 'WEBAUTHN_REGISTERED', null, {}, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) {
    console.error('webauthn register/verify:', e.message);
    res.status(500).json({ ok: false, error: 'Ошибка регистрации Face ID' });
  }
});

// Вход по Face ID — публично (пользователь ещё не авторизован).
router.post('/webauthn/login/options', async (req, res) => {
  try {
    const wa = require('../webauthn');
    const options = await wa.authenticationOptions(req);
    setChallenge(res, { c: options.challenge, t: 'login' });
    res.json(options);
  } catch (e) {
    console.error('webauthn login/options:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось начать вход по Face ID' });
  }
});

router.post('/webauthn/login/verify', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  const ua = req.headers['user-agent'];
  try {
    const blocked = await checkLoginRateLimit(ip + ':wa');
    if (blocked) return res.status(429).json({ ok: false, error: 'Слишком много попыток' });
    const wa = require('../webauthn');
    const ch = readChallenge(req);
    if (!ch || ch.t !== 'login') return res.status(400).json({ ok: false, error: 'Сессия входа истекла, попробуйте снова' });
    const { response } = req.body || {};
    const r = await wa.verifyAuthentication(req, response, ch.c);
    res.clearCookie(WA_CHAL_COOKIE);
    if (!r.verified) {
      await recordLoginAttempt(ip + ':wa');
      return res.status(401).json({ ok: false, error: 'Face ID не распознан' });
    }
    const ur = await pool.query('SELECT * FROM ticketsmodule_users WHERE id=$1 AND active=true', [r.userId]);
    if (!ur.rows.length) return res.status(401).json({ ok: false, error: 'Пользователь не найден или отключён' });
    const user = ur.rows[0];
    await clearLoginAttempts(ip + ':wa');
    const spec = sessionSpec((req.body || {}).rememberDays);
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: spec.expiresIn });
    res.cookie('token', token, COOKIE_OPTS(spec.maxAge));
    await auditLog(user.id, user.username, 'LOGIN_FACEID_SUCCESS', null, { rememberDays: spec.maxAge / 86400000 }, ip, ua);
    res.json({ ok: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role, engineerName: user.engineer_name } });
  } catch (e) {
    console.error('webauthn login/verify:', e.message);
    res.status(401).json({ ok: false, error: 'Ошибка входа по Face ID' });
  }
});

// Статус (сколько устройств привязано) и отключение.
router.get('/webauthn/status', requireAuth(), async (req, res) => {
  try {
    const n = await require('../webauthn').countForUser(req.user.id);
    res.json({ ok: true, enabled: n > 0, count: n });
  } catch (e) { res.json({ ok: true, enabled: false, count: 0 }); }
});

router.post('/webauthn/disable', requireAuth(), async (req, res) => {
  try {
    await require('../webauthn').disableForUser(req.user.id);
    await auditLog(req.user.id, req.user.username, 'WEBAUTHN_DISABLED', null, {}, req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = router;

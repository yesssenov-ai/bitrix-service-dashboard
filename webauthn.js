// Вход по Face ID / Touch ID / Windows Hello — через WebAuthn (passkeys).
// iOS показывает Face ID как «платформенный аутентификатор» стандартного WebAuthn.
// Пользователь один раз входит по паролю и включает Face ID (регистрирует passkey),
// далее заходит по лицу. Ключи привязаны к домену приложения.
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { pool } = require('./auth');

const RP_NAME = 'ProLabSupport ЦУП';

// rpID/origin выводим из запроса — работает на любом домене, где открыт дашборд.
function rpFrom(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const rpID = host.split(':')[0];
  const origin = `${proto}://${host}`;
  return { rpID, origin };
}

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_webauthn_creds (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        cred_id TEXT UNIQUE NOT NULL,
        public_key TEXT NOT NULL,
        counter BIGINT DEFAULT 0,
        transports TEXT,
        label TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_used_at TIMESTAMPTZ);
      CREATE INDEX IF NOT EXISTS idx_wa_user ON ticketsmodule_webauthn_creds(user_id);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

async function credsOfUser(userId) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_webauthn_creds WHERE user_id=$1 ORDER BY id', [userId]);
  return rows;
}

// ── Регистрация (включение Face ID) ─────────────────────────────────────────
async function registrationOptions(req, user) {
  await ensureSchema();
  const { rpID } = rpFrom(req);
  const existing = await credsOfUser(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: String(user.id),
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: Buffer.from(c.cred_id, 'base64url'), type: 'public-key' })),
    authenticatorSelection: {
      residentKey: 'preferred',       // discoverable — вход без ввода логина
      requireResidentKey: false,
      userVerification: 'required',   // требуем биометрию/код (Face ID)
    },
    supportedAlgorithmIDs: [-7, -257],
  });
  return options; // options.challenge — base64url-строка
}

async function verifyRegistration(req, user, response, challenge, label) {
  await ensureSchema();
  const { rpID, origin } = rpFrom(req);
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verification.verified || !verification.registrationInfo) return { verified: false };
  const info = verification.registrationInfo;
  const credId = Buffer.from(info.credentialID).toString('base64url');
  const pubKey = Buffer.from(info.credentialPublicKey).toString('base64');
  const transports = Array.isArray(response.response && response.response.transports)
    ? response.response.transports.join(',') : null;
  await pool.query(
    `INSERT INTO ticketsmodule_webauthn_creds (user_id, cred_id, public_key, counter, transports, label)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (cred_id) DO UPDATE SET public_key=EXCLUDED.public_key, counter=EXCLUDED.counter, user_id=EXCLUDED.user_id`,
    [user.id, credId, pubKey, info.counter || 0, transports, (label || 'Устройство').slice(0, 80)]);
  return { verified: true };
}

// ── Аутентификация (вход по Face ID) ────────────────────────────────────────
async function authenticationOptions(req) {
  await ensureSchema();
  const { rpID } = rpFrom(req);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    // allowCredentials пуст — используем discoverable passkey (без ввода логина).
  });
  return options;
}

async function verifyAuthentication(req, response, challenge) {
  await ensureSchema();
  const { rpID, origin } = rpFrom(req);
  const credId = response && response.id; // base64url
  if (!credId) return { verified: false };
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_webauthn_creds WHERE cred_id=$1', [credId]);
  if (!rows.length) return { verified: false };
  const cred = rows[0];
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
    authenticator: {
      credentialID: Buffer.from(cred.cred_id, 'base64url'),
      credentialPublicKey: Buffer.from(cred.public_key, 'base64'),
      counter: Number(cred.counter) || 0,
    },
  });
  if (!verification.verified) return { verified: false };
  await pool.query('UPDATE ticketsmodule_webauthn_creds SET counter=$1, last_used_at=NOW() WHERE id=$2',
    [verification.authenticationInfo.newCounter, cred.id]).catch(() => {});
  return { verified: true, userId: cred.user_id };
}

async function disableForUser(userId) {
  await ensureSchema();
  await pool.query('DELETE FROM ticketsmodule_webauthn_creds WHERE user_id=$1', [userId]);
  return { ok: true };
}

async function countForUser(userId) {
  const rows = await credsOfUser(userId);
  return rows.length;
}

module.exports = {
  registrationOptions, verifyRegistration,
  authenticationOptions, verifyAuthentication,
  disableForUser, countForUser, ensureSchema,
};

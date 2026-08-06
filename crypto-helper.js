// Simple AES-256-GCM encryption for storing sensitive values (Yandex app
// passwords) at rest. Key is derived from JWT_SECRET so no extra env var
// setup is needed — same secret already trusted for auth tokens.
const crypto = require('crypto');
const { JWT_SECRET } = require('./auth');

const KEY = crypto.createHash('sha256').update(String(JWT_SECRET)).digest(); // 32 bytes for AES-256

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(encoded) {
  const buf = Buffer.from(encoded, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };

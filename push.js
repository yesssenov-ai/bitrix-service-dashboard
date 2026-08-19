// Web Push (VAPID) — уведомления и бейдж на иконке приложения даже когда оно
// закрыто. Подписки хранятся в БД по bitrix_user_id. Ключи VAPID берутся из env
// (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT); если не заданы —
// используются встроенные значения по умолчанию (публичный ключ можно показывать,
// приватный лучше вынести в env на проде).
const webpush = require('web-push');
const { pool } = require('./auth');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || 'BOnNfTksh9U_qenpEQaQYDCnT1g87tCsctGZi8q_acWsY1smNVCGgXf86KBiGls2-xKtbNMKRkilhhHKaCa2nUQ';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || 'Bww-3iPFvZf9cl3CQc-63KvWg4ZTZcaP88PXWCKNs3U';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:service@prolabsupport.kz';

let _enabled = false;
try {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  _enabled = true;
} catch (e) { console.error('web-push VAPID init:', e.message); }

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_push_subs (
        id SERIAL PRIMARY KEY,
        bid INTEGER,
        endpoint TEXT UNIQUE NOT NULL,
        sub JSONB NOT NULL,
        last_count INTEGER DEFAULT -1,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_push_bid ON ticketsmodule_push_subs(bid);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

const enabled = () => _enabled;
const publicKey = () => VAPID_PUBLIC;

async function saveSubscription(bid, sub) {
  await ensureSchema();
  if (!sub || !sub.endpoint) throw new Error('Некорректная подписка');
  await pool.query(
    `INSERT INTO ticketsmodule_push_subs (bid, endpoint, sub) VALUES ($1,$2,$3)
     ON CONFLICT (endpoint) DO UPDATE SET bid=EXCLUDED.bid, sub=EXCLUDED.sub, updated_at=NOW()`,
    [bid || null, sub.endpoint, JSON.stringify(sub)]);
  return { ok: true };
}

async function removeSubscription(endpoint) {
  await ensureSchema();
  if (endpoint) await pool.query('DELETE FROM ticketsmodule_push_subs WHERE endpoint=$1', [endpoint]);
  return { ok: true };
}

async function _send(row, payload) {
  try {
    const sub = typeof row.sub === 'string' ? JSON.parse(row.sub) : row.sub;
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return true;
  } catch (e) {
    // 404/410 — подписка мертва, удаляем.
    if (e.statusCode === 404 || e.statusCode === 410) {
      await pool.query('DELETE FROM ticketsmodule_push_subs WHERE endpoint=$1', [row.endpoint]).catch(() => {});
    }
    return false;
  }
}

// Разовый пуш конкретному пользователю (напр. «требуется согласование»).
async function sendToUser(bid, payload) {
  if (!_enabled || !bid) return 0;
  await ensureSchema();
  const { rows } = await pool.query('SELECT endpoint, sub FROM ticketsmodule_push_subs WHERE bid=$1', [bid]);
  let n = 0;
  for (const r of rows) { if (await _send(r, payload)) n++; }
  return n;
}

// Периодический пересчёт бейджей всех подписанных пользователей. Пуш шлём только
// когда число изменилось (тихо обновить бейдж), а всплывающее уведомление — только
// когда оно ВЫРОСЛО. Вызывается по таймеру из server.js.
async function broadcastBadges() {
  if (!_enabled) return;
  await ensureSchema();
  const { pendingForBid } = require('./pending-actions');
  const { rows: bids } = await pool.query('SELECT DISTINCT bid FROM ticketsmodule_push_subs WHERE bid IS NOT NULL');
  for (const { bid } of bids) {
    let count = 0;
    try { ({ count } = await pendingForBid(bid)); } catch (e) { continue; }
    const subs = (await pool.query('SELECT id, endpoint, sub, last_count FROM ticketsmodule_push_subs WHERE bid=$1', [bid])).rows;
    for (const s of subs) {
      const prev = Number(s.last_count);
      if (prev === Number(count)) continue; // без изменений — не трогаем
      const payload = { type: 'badge', count };
      if (count > (prev >= 0 ? prev : 0)) {
        payload.notify = { title: 'ProLabSupport ЦУП', body: `Новых действий для вас: ${count}` };
      }
      await _send(s, payload);
      await pool.query('UPDATE ticketsmodule_push_subs SET last_count=$1, updated_at=NOW() WHERE id=$2', [count, s.id]).catch(() => {});
    }
  }
}

module.exports = { enabled, publicKey, saveSubscription, removeSubscription, sendToUser, broadcastBadges, ensureSchema };

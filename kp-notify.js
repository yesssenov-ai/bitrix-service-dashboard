const { sendPersonalTg, sendPersonalEmail } = require('./manager-notifications');

// Resolves a Bitrix user ID from a ЦУП account, since our personal-notify
// functions are keyed by Bitrix ID (see USERS in constants.js) — but KP
// module users are addressed by their ЦУП account id. Reuse the same
// reverse-lookup the planner already built.
async function resolveBitrixIdForAccount(accountUserId) {
  const { pool } = require('./auth');
  const { rows } = await pool.query('SELECT engineer_name FROM ticketsmodule_users WHERE id=$1', [accountUserId]);
  const name = rows[0]?.engineer_name;
  if (!name) return null;
  const { USERS } = require('./constants');
  const found = Object.entries(USERS).find(([, n]) => n === name);
  return found ? parseInt(found[0], 10) : null;
}

async function notifyPersonal(accountUserId, title, body, path) {
  const bitrixId = await resolveBitrixIdForAccount(accountUserId);
  if (!bitrixId) { console.warn(`KP notify: no Bitrix ID for account #${accountUserId} — skipping`); return; }
  const base = process.env.APP_BASE_URL || 'https://nms.prolabsupport.kz';
  const text = `<b>${title}</b>\n${body}\n\n🔗 <a href="${base}${path}">Открыть в ЦУП</a>`;
  await sendPersonalTg(bitrixId, text);
  await sendPersonalEmail(bitrixId, title, `<p>${body}</p><p><a href="${base}${path}">Открыть в ЦУП</a></p>`);
}

module.exports = { notifyPersonal };

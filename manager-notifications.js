const fetch = require('node-fetch');
const { USER_EMAILS } = require('./constants');

const RESEND_KEY = process.env.RESEND_API_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const FROM_EMAIL = 'service@prolabsupport.kz';

let pool = null;
function setPool(p) { pool = p; }

// ── Get manager's Telegram chat_id from DB ────────────────────────────────────

async function getManagerTelegramChatId(bitrixUserId) {
  if (!pool) return null;
  try {
    const r = await pool.query(
      'SELECT telegram_chat_id FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1',
      [bitrixUserId]
    );
    return r.rows[0]?.telegram_chat_id || null;
  } catch(e) {
    console.error('getManagerTelegramChatId error:', e.message);
    return null;
  }
}

// ── Send personal Telegram message ────────────────────────────────────────────

async function sendPersonalTg(bitrixUserId, text) {
  const chatId = await getManagerTelegramChatId(bitrixUserId);
  if (!chatId || !TG_TOKEN) return false;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    return true;
  } catch(e) {
    console.error('sendPersonalTg error:', e.message);
    return false;
  }
}

// ── Send personal email ───────────────────────────────────────────────────────

async function sendPersonalEmail(bitrixUserId, subject, html) {
  const email = USER_EMAILS[bitrixUserId];
  if (!email || !RESEND_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `ProLabSupport Service <${FROM_EMAIL}>`,
        to: [email],
        subject,
        html,
      }),
    });
    const d = await r.json();
    if (!r.ok) console.error('Resend error:', d);
    return r.ok;
  } catch(e) {
    console.error('sendPersonalEmail error:', e.message);
    return false;
  }
}

// ── Notify manager: child process completed ───────────────────────────────────

async function notifyProcessCompleted(managerId, { entityName, entityTypeId, itemId, title, stageName, url, dealUrl, dealId }) {
  const cleanTitle = (title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `#${itemId}`;

  const tgText = `✅ <b>Завершён процесс: ${entityName}</b>\n` +
    `📋 ${cleanTitle}\n` +
    `📌 Стадия: <b>${stageName}</b>\n` +
    `🔗 <a href="${url}">Открыть процесс</a>\n` +
    (dealUrl ? `\n⬆️ <a href="${dealUrl}">Открыть родительскую сделку</a>` : '');
  await sendPersonalTg(managerId, tgText);

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#0e7c3f;padding:18px 22px;border-radius:10px 10px 0 0">
        <h2 style="color:#fff;margin:0;font-size:17px">✅ Завершён процесс</h2>
        <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">${esc(entityName)}</p>
      </div>
      <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:22px;border-radius:0 0 10px 10px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:7px 0;color:#6b7280;font-size:13px;width:130px">Процесс</td><td style="padding:7px 0;font-weight:600">#${itemId} — ${esc(cleanTitle)}</td></tr>
          <tr><td style="padding:7px 0;color:#6b7280;font-size:13px">Стадия</td><td style="padding:7px 0"><span style="background:#dff6dd;color:#0e7c3f;padding:2px 10px;border-radius:6px;font-size:13px;font-weight:600">${esc(stageName)}</span></td></tr>
        </table>
        <div style="margin-top:18px;display:flex;gap:10px">
          <a href="${url}" style="background:#0f6cbd;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Открыть процесс</a>
          ${dealUrl ? `<a href="${dealUrl}" style="background:#fff;border:1px solid #d2d0ce;color:#201f1e;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-left:8px">Открыть сделку</a>` : ''}
        </div>
      </div>
      <p style="color:#9ca3af;font-size:11.5px;text-align:center;margin-top:14px">ProLabSupport Service Dashboard</p>
    </div>`;
  await sendPersonalEmail(managerId, `✅ Завершён процесс: ${entityName} #${itemId}`, html);
}

// ── Notify manager: engineer assigned ─────────────────────────────────────────

async function notifyEngineerAssigned(managerId, { itemId, title, engineerName, url, dealUrl }) {
  const cleanTitle = (title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `#${itemId}`;

  const tgText = `👤 <b>Назначен инженер</b>\n` +
    `📋 Заявка на сервис #${itemId}: ${cleanTitle}\n` +
    `🔧 Инженер: <b>${esc(engineerName)}</b>\n` +
    `🔗 <a href="${url}">Открыть заявку</a>` +
    (dealUrl ? `\n⬆️ <a href="${dealUrl}">Открыть родительскую сделку</a>` : '');
  await sendPersonalTg(managerId, tgText);

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#0f6cbd;padding:18px 22px;border-radius:10px 10px 0 0">
        <h2 style="color:#fff;margin:0;font-size:17px">👤 Назначен инженер</h2>
        <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">Заявка на сервис</p>
      </div>
      <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:22px;border-radius:0 0 10px 10px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:7px 0;color:#6b7280;font-size:13px;width:130px">Заявка</td><td style="padding:7px 0;font-weight:600">#${itemId} — ${esc(cleanTitle)}</td></tr>
          <tr><td style="padding:7px 0;color:#6b7280;font-size:13px">Инженер</td><td style="padding:7px 0;font-weight:600">${esc(engineerName)}</td></tr>
        </table>
        <div style="margin-top:18px">
          <a href="${url}" style="background:#0f6cbd;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Открыть заявку</a>
          ${dealUrl ? `<a href="${dealUrl}" style="background:#fff;border:1px solid #d2d0ce;color:#201f1e;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-left:8px">Открыть сделку</a>` : ''}
        </div>
      </div>
      <p style="color:#9ca3af;font-size:11.5px;text-align:center;margin-top:14px">ProLabSupport Service Dashboard</p>
    </div>`;
  await sendPersonalEmail(managerId, `👤 Назначен инженер: заявка #${itemId}`, html);
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

module.exports = {
  setPool, getManagerTelegramChatId, sendPersonalTg, sendPersonalEmail,
  notifyProcessCompleted, notifyEngineerAssigned,
};

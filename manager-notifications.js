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

async function sendPersonalTg(bitrixUserId, text, _isRetry = false) {
  const chatId = await getManagerTelegramChatId(bitrixUserId);
  if (!chatId || !TG_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      // Telegram rejected it — most commonly 429 (too many messages to this
      // chat). Respect retry_after and try once more instead of silently
      // reporting success on a message that never actually arrived.
      const retryAfter = data?.parameters?.retry_after;
      if (!_isRetry && retryAfter) {
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        return sendPersonalTg(bitrixUserId, text, true);
      }
      console.error(`sendPersonalTg failed for user ${bitrixUserId}:`, JSON.stringify(data));
      return false;
    }
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

// ── Notify engineer + sales manager: full job assignment details ──────────────

async function notifyJobAssigned({ engineerId, managerId, itemId, title, reason, svcLabel,
  engineerName, assignDate, startDate, endDate, clientName, contractLabel,
  managerName, instrLabel, location, url, dealUrl }) {

  const headerText = reason || 'Назначен инженер на заявку';
  const cleanTitle = (title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `#${itemId}`;

  const row = (label, val) => val ? `${label}: <b>${esc(val)}</b>\n` : '';
  const tgText = `🔧 <b>${esc(headerText)}</b>\n` +
    `📋 Заявка на сервис #${itemId}: ${esc(cleanTitle)}\n\n` +
    row('Тип услуг', svcLabel) +
    row('Ответственный инженер', engineerName) +
    row('Дата назначения', assignDate) +
    row('Дата начала работ', startDate) +
    row('Дата завершения работ', endDate) +
    row('Клиент / Компания', clientName) +
    row('Контракт', contractLabel) +
    row('Ответственный сейл-менеджер', managerName) +
    row('Прибор', instrLabel) +
    row('Локация', location) +
    `\n🔗 <a href="${url}">Открыть заявку</a>` +
    (dealUrl ? `\n⬆️ <a href="${dealUrl}">Открыть родительскую сделку</a>` : '');

  const emailRow = (label, val) => val ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:190px">${esc(label)}</td><td style="padding:6px 0;font-weight:600">${esc(val)}</td></tr>` : '';
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#0f6cbd;padding:18px 22px;border-radius:10px 10px 0 0">
        <h2 style="color:#fff;margin:0;font-size:17px">🔧 ${esc(headerText)}</h2>
        <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">Заявка на сервис #${itemId}</p>
      </div>
      <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:22px;border-radius:0 0 10px 10px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:190px">Заявка</td><td style="padding:6px 0;font-weight:600">#${itemId} — ${esc(cleanTitle)}</td></tr>
          ${emailRow('Тип оказываемых услуг', svcLabel)}
          ${emailRow('Ответственный инженер', engineerName)}
          ${emailRow('Дата назначения', assignDate)}
          ${emailRow('Дата начала работ', startDate)}
          ${emailRow('Дата завершения работ', endDate)}
          ${emailRow('Клиент / Компания', clientName)}
          ${emailRow('Контракт', contractLabel)}
          ${emailRow('Ответственный сейл-менеджер', managerName)}
          ${emailRow('Название прибора', instrLabel)}
          ${emailRow('Локация', location)}
        </table>
        <div style="margin-top:18px">
          <a href="${url}" style="background:#0f6cbd;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Открыть заявку</a>
          ${dealUrl ? `<a href="${dealUrl}" style="background:#fff;border:1px solid #d2d0ce;color:#201f1e;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-left:8px">Открыть сделку</a>` : ''}
        </div>
      </div>
      <p style="color:#9ca3af;font-size:11.5px;text-align:center;margin-top:14px">ProLabSupport Service Dashboard</p>
    </div>`;

  const recipients = [...new Set([engineerId, managerId].filter(Boolean))];
  const nameByUid = {};
  if (engineerId) nameByUid[engineerId] = engineerName;
  if (managerId) nameByUid[managerId] = managerName;

  for (const uid of recipients) {
    const tgOk = await sendPersonalTg(uid, tgText);
    await logNotification({ itemId, reason: headerText, channel: 'telegram', recipientId: uid, recipientLabel: nameByUid[uid] || `#${uid}`, success: tgOk });

    const emailAddr = USER_EMAILS[uid] || null;
    const emailOk = await sendPersonalEmail(uid, `🔧 ${headerText}: заявка #${itemId}`, html);
    await logNotification({ itemId, reason: headerText, channel: 'email', recipientId: uid, recipientLabel: emailAddr || nameByUid[uid] || `#${uid}`, success: emailOk });
  }
}

async function logNotification({ itemId, reason, channel, recipientId, recipientLabel, success, error }) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_notification_log (bitrix_item_id, reason, channel, recipient_bitrix_id, recipient_label, success, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [itemId || null, reason || null, channel, recipientId || null, recipientLabel || null, success, error || null]
    );
  } catch (e) {
    console.error('logNotification error:', e.message);
  }
}

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

module.exports = {
  setPool, getManagerTelegramChatId, sendPersonalTg, sendPersonalEmail,
  notifyProcessCompleted, notifyEngineerAssigned, notifyJobAssigned, logNotification,
};

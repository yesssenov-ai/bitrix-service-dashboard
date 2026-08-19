// Уведомления модуля «Закуп доп оборудования»: Telegram + Email + Bitrix, best-effort.
// Шлём по bitrix_user_id (Telegram — через ticketsmodule_telegram_links, Email —
// через Resend по карте USER_EMAILS, Bitrix — im.notify). Любой канал может быть
// недоступен (не привязан TG / нет права im) — тогда просто пропускаем и логируем.
const fetch = require('node-fetch');
const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const { USER_EMAILS } = require('./constants');

const RESEND_KEY = process.env.RESEND_API_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const FROM_EMAIL = 'service@prolabsupport.kz';
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tgChat(uid) {
  try { const r = await pool.query('SELECT telegram_chat_id FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [uid]); return r.rows[0]?.telegram_chat_id || null; }
  catch (e) { return null; }
}
async function sendTg(uid, text) {
  const chat = await tgChat(uid); if (!chat || !TG_TOKEN) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
    const d = await res.json().catch(() => null);
    return !!(res.ok && d && d.ok);
  } catch (e) { return false; }
}
async function sendEmail(uid, subject, html, attachments) {
  const email = USER_EMAILS[uid]; if (!email || !RESEND_KEY) return false;
  try {
    const body = { from: `ProLabSupport <${FROM_EMAIL}>`, to: [email], subject, html };
    // Вложения Resend: { filename, content } где content — base64-строка.
    if (Array.isArray(attachments) && attachments.length) {
      body.attachments = attachments
        .filter(a => a && a.filename && a.content)
        .map(a => ({ filename: a.filename, content: a.content }));
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch (e) { return false; }
}
async function imNotify(uid, message) {
  try { await b24('im.notify.personal.add', { USER_ID: uid, MESSAGE: message }); return true; }
  catch (e) { return false; }
}
async function logN(itemId, reason, channel, uid, success) {
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_notification_log (bitrix_item_id, reason, channel, recipient_bitrix_id, recipient_label, success)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [itemId || null, reason || null, channel, uid || null, String(uid || ''), success]
    );
  } catch (e) { /* лог не критичен */ }
}

function emailHtml({ title, color, lines, itemUrl, dashUrl }) {
  const rows = (lines || []).map(([l, v]) => `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:150px">${esc(l)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('');
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto">
    <div style="background:${color || '#0f6cbd'};padding:16px 20px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:16px">${esc(title)}</h2></div>
    <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:20px;border-radius:0 0 10px 10px">
      <table style="width:100%;border-collapse:collapse">${rows}</table>
      <div style="margin-top:16px">
        ${dashUrl ? `<a href="${dashUrl}" style="background:#0f6cbd;color:#fff;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Открыть в дашборде</a>` : ''}
        ${itemUrl ? `<a href="${itemUrl}" style="background:#fff;border:1px solid #d2d0ce;color:#201f1e;padding:9px 16px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-left:8px">Открыть в Битриксе</a>` : ''}
      </div>
    </div>
    <p style="color:#9ca3af;font-size:11.5px;text-align:center;margin-top:12px">ProLabSupport · Закупки</p>
  </div>`;
}

// Отправить одному человеку по всем каналам (best-effort) + залогировать.
async function notifyPerson(uid, { reason, tgText, subject, html, itemId, attachments }) {
  if (!uid) return;
  const tg = await sendTg(uid, tgText); await logN(itemId, reason, 'telegram', uid, tg);
  const em = await sendEmail(uid, subject, html, attachments); await logN(itemId, reason, 'email', uid, em);
  const im = await imNotify(uid, String(tgText || '').replace(/<[^>]+>/g, '')); await logN(itemId, reason, 'bitrix', uid, im);
  // Web Push — уведомление на иконку приложения (работает и когда оно закрыто).
  try {
    const push = require('./push');
    if (push.enabled()) {
      const body = String(tgText || subject || '').replace(/<[^>]+>/g, '').replace(/\n+/g, ' ').trim().slice(0, 140);
      await push.sendToUser(uid, { type: 'alert', notify: { title: subject || 'ProLabSupport ЦУП', body }, url: '/procurement.html' });
    }
  } catch (e) { /* push best-effort */ }
}

module.exports = { notifyPerson, emailHtml, esc };

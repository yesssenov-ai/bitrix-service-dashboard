const fetch = require('node-fetch');

const RESEND_KEY = process.env.RESEND_API_KEY;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_MGT = process.env.TG_MGT_CHAT;

const COORD_EMAILS = ['azamat.a@prolabsupport.kz', 'arman.man@prolabsupport.kz'];
const FROM_EMAIL = 'service@prolabsupport.kz';

// ── Telegram ──────────────────────────────────────────────────────────────────

async function tgMgt(text) {
  if (!TG_TOKEN || !TG_MGT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_MGT, text, parse_mode: 'HTML' }),
    });
  } catch(e) { console.error('TG MGT error:', e.message); }
}

async function tgOps(text) {
  const TG_OPS = process.env.TG_OPS_CHAT;
  if (!TG_TOKEN || !TG_OPS) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_OPS, text, parse_mode: 'HTML' }),
    });
  } catch(e) { console.error('TG OPS error:', e.message); }
}

async function tgBoth(text) {
  await Promise.all([tgMgt(text), tgOps(text)]);
}

// ── Resend ────────────────────────────────────────────────────────────────────

async function sendEmail(subject, html) {
  if (!RESEND_KEY) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `ProLabSupport Service <${FROM_EMAIL}>`,
        to: COORD_EMAILS,
        subject,
        html,
      }),
    });
    const d = await r.json();
    if (!r.ok) console.error('Resend error:', d);
  } catch(e) { console.error('Resend error:', e.message); }
}

// ── New ticket notification ───────────────────────────────────────────────────

async function notifyNewTicket(ticket) {
  const title = (ticket.title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `Заявка #${ticket.id}`;
  const svc = ticket.serviceTypes?.join(', ') || '—';
  const url = ticket.bitrixUrl || `https://crm.prolabsupport.kz/crm/type/1058/details/${ticket.id}/`;

  // Telegram → только Руководство
  const tgText = `🆕 <b>Новая заявка #${ticket.id}</b>\n` +
    `📋 ${title}\n` +
    `🔧 Тип: ${svc}\n` +
    `⏰ Создана: ${new Date().toLocaleString('ru', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}\n` +
    `🔗 <a href="${url}">Открыть в Битрикс24</a>`;
  await tgMgt(tgText);

  // Email → координаторам
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#C53B2F;padding:20px 24px;border-radius:10px 10px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">🆕 Новая сервисная заявка</h2>
      </div>
      <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:24px;border-radius:0 0 10px 10px">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px;width:140px">Номер заявки</td><td style="padding:8px 0;font-weight:600">#${ticket.id}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Название</td><td style="padding:8px 0">${title}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Тип услуги</td><td style="padding:8px 0">${svc}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Стадия</td><td style="padding:8px 0">${ticket.stageName || 'Необработанные'}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Срочность</td><td style="padding:8px 0">${ticket.urgency || 'Не указана'}</td></tr>
          <tr><td style="padding:8px 0;color:#6b7280;font-size:13px">Время</td><td style="padding:8px 0">${new Date().toLocaleString('ru', { timeZone: 'Asia/Almaty' })}</td></tr>
        </table>
        ${ticket.description ? `<div style="background:#f5f6fa;border-radius:8px;padding:12px 16px;margin-top:16px;font-size:13px;color:#374151">${ticket.description}</div>` : ''}
        <div style="margin-top:20px">
          <a href="${url}" style="background:#C53B2F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Открыть в Битрикс24</a>
        </div>
      </div>
      <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:16px">ProLabSupport Service Dashboard</p>
    </div>`;

  await sendEmail(`🆕 Новая заявка #${ticket.id}: ${title}`, html);
}

// ── Overdue NEW tickets notification ─────────────────────────────────────────

async function notifyOverdueNew(tickets) {
  if (!tickets.length) return;

  // Telegram
  const lines = tickets.map(t => {
    const title = (t.title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `#${t.id}`;
    const hours = Math.floor(t.daysOnStage * 24);
    return `• <a href="${t.bitrixUrl}">#${t.id}</a> — ${title.slice(0, 60)} (${hours > 24 ? Math.floor(hours/24) + ' дн.' : hours + ' ч.'})`;
  }).join('\n');

  await tgMgt(
    `⚠️ <b>Необработанные заявки > 8 часов (${tickets.length})</b>\n\n${lines}\n\n` +
    `🔗 <a href="${process.env.DASH_URL || 'https://bitrix-service-dashboard-production.up.railway.app'}">Открыть дашборд</a>`
  );

  // Email
  const rows = tickets.map(t => {
    const title = (t.title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `Заявка #${t.id}`;
    const hours = Math.round(t.daysOnStage * 24);
    const created = t.createdTime ? new Date(t.createdTime).toLocaleString('ru', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
    return `<tr style="border-bottom:1px solid #e3e6ef">
      <td style="padding:10px 12px"><a href="${t.bitrixUrl}" style="color:#C53B2F;font-weight:600">#${t.id}</a></td>
      <td style="padding:10px 12px;font-size:13px">${title.slice(0, 80)}</td>
      <td style="padding:10px 12px;font-size:13px">${created}</td>
      <td style="padding:10px 12px;font-size:13px;color:#dc2626;font-weight:600">${hours > 24 ? Math.floor(hours/24) + ' дн.' : hours + ' ч.'}</td>
    </tr>`;
  }).join('');

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:700px;margin:0 auto">
      <div style="background:#dc2626;padding:20px 24px;border-radius:10px 10px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">⚠️ Необработанные заявки более 8 часов</h2>
        <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:14px">${tickets.length} заявок требуют внимания</p>
      </div>
      <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;border-radius:0 0 10px 10px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f5f6fa">
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">ID</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Заявка</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Создана</th>
              <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase">Ожидает</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <div style="padding:20px 24px">
          <a href="${process.env.DASH_URL || 'https://bitrix-service-dashboard-production.up.railway.app'}" style="background:#C53B2F;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Открыть дашборд</a>
        </div>
      </div>
      <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:16px">ProLabSupport Service Dashboard · Автоматическое уведомление</p>
    </div>`;

  await sendEmail(`⚠️ ${tickets.length} необработанных заявок более 8 часов`, html);
}

module.exports = { tgMgt, tgOps, tgBoth, sendEmail, notifyNewTicket, notifyOverdueNew };

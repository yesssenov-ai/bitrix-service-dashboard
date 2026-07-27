const RESEND_KEY = process.env.RESEND_API_KEY;

function timeAgo(dateStr) {
  const m = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  return `${Math.floor(h / 24)} д назад`;
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Almaty'
  });
}

async function sendEmailReport(stats, pendingEmails, customEmail = null) {
  if (!RESEND_KEY) return;
  const recipients = customEmail
    ? [customEmail]
    : (process.env.MAIL_REPORT_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!recipients.length) return;

  const dashboardUrl = 'https://nms.prolabsupport.kz/mail.html';
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: 'long', year: 'numeric' });

  const unanswered = pendingEmails.filter(e => e.category === 'client' || e.category === 'uncategorized');

  const pendingRows = unanswered.map(e => {
    const catLabel = e.category === 'client' ? '🟢 Клиент' : '❓ Без категории';
    const catColor = e.category === 'client' ? '#0891B2' : '#D97706';
    const waitTime = timeAgo(e.received_at);
    return `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;vertical-align:top">
        <div style="font-weight:600;color:#111827;margin-bottom:2px">${e.from_name || e.from_addr}</div>
        <div style="font-size:12px;color:#9CA3AF">${e.from_addr}</div>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;vertical-align:top">
        <a href="${dashboardUrl}" style="color:#111827;font-weight:500;text-decoration:none;display:block;margin-bottom:2px">${e.subject || '(без темы)'}</a>
        <div style="font-size:12px;color:#9CA3AF;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${(e.body_preview || '').slice(0, 100)}</div>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;white-space:nowrap;vertical-align:top">
        <div style="font-size:12px;color:#6B7280">${formatDate(e.received_at)}</div>
        <div style="font-size:12px;color:#DC2626;font-weight:500;margin-top:2px">⏳ ${waitTime}</div>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #F3F4F6;vertical-align:top">
        <span style="background:${catColor}15;color:${catColor};border:1px solid ${catColor}40;padding:3px 8px;border-radius:5px;font-size:11px;font-weight:600;white-space:nowrap">${catLabel}</span>
      </td>
    </tr>`;
  }).join('');

  const totalToday = parseInt(stats.total) || 0;
  const answeredToday = parseInt(stats.answered) || 0;
  const unansweredCount = unanswered.length;
  const clientCount = parseInt(stats.client) || 0;
  const tenderCount = parseInt(stats.tender) || 0;
  const spamCount = (parseInt(stats.spam) || 0) + (parseInt(stats.adv) || 0);

  const html = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#F5F6FA;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:680px;margin:0 auto;padding:24px 16px">
  <div style="background:#C53B2F;border-radius:12px 12px 0 0;padding:24px 28px;display:flex;align-items:center;gap:14px">
    <div style="background:rgba(255,255,255,0.2);border-radius:8px;padding:8px 12px;font-size:14px;font-weight:700;color:#fff">PLS</div>
    <div>
      <div style="font-size:18px;font-weight:700;color:#fff">ProLabSupport Mail Tracker</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:2px">Ежедневный отчёт · ${today}</div>
    </div>
  </div>
  <div style="background:#fff;padding:24px 28px;border-left:1px solid #E4E6EF;border-right:1px solid #E4E6EF">
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:8px">
      <div style="background:#F5F6FA;border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:32px;font-weight:700;color:#C53B2F;line-height:1">${totalToday}</div>
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Всего сегодня</div>
      </div>
      <div style="background:#ECFDF5;border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:32px;font-weight:700;color:#059669;line-height:1">${answeredToday}</div>
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Отвечено</div>
      </div>
      <div style="background:${unansweredCount > 0 ? '#FEF2F2' : '#ECFDF5'};border-radius:10px;padding:16px;text-align:center">
        <div style="font-size:32px;font-weight:700;color:${unansweredCount > 0 ? '#DC2626' : '#059669'};line-height:1">${unansweredCount}</div>
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px">Без ответа</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">
      <div style="border:1px solid #E4E6EF;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:#0891B2">${clientCount}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:2px">Клиенты</div>
      </div>
      <div style="border:1px solid #E4E6EF;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:#7C3AED">${tenderCount}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:2px">Тендеры</div>
      </div>
      <div style="border:1px solid #E4E6EF;border-radius:8px;padding:12px;text-align:center">
        <div style="font-size:20px;font-weight:700;color:#9CA3AF">${spamCount}</div>
        <div style="font-size:11px;color:#9CA3AF;margin-top:2px">Спам + Реклама</div>
      </div>
    </div>
  </div>
  ${unansweredCount > 0 ? `
  <div style="background:#fff;border-left:1px solid #E4E6EF;border-right:1px solid #E4E6EF;border-top:1px solid #F3F4F6;padding:20px 28px 0">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <div style="width:8px;height:8px;border-radius:50%;background:#DC2626"></div>
      <div style="font-size:15px;font-weight:600;color:#111827">Письма без ответа (${unansweredCount})</div>
    </div>
  </div>
  <div style="background:#fff;border-left:1px solid #E4E6EF;border-right:1px solid #E4E6EF;overflow:hidden">
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#F9FAFB">
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:1px solid #F3F4F6">Отправитель</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:1px solid #F3F4F6">Тема</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:1px solid #F3F4F6">Получено</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:1px solid #F3F4F6">Категория</th>
        </tr>
      </thead>
      <tbody>${pendingRows}</tbody>
    </table>
  </div>` : `
  <div style="background:#ECFDF5;border-left:1px solid #E4E6EF;border-right:1px solid #E4E6EF;border-top:1px solid #F3F4F6;padding:24px 28px;text-align:center">
    <div style="font-size:32px;margin-bottom:8px">🎉</div>
    <div style="font-size:15px;font-weight:600;color:#059669">Все письма получили ответ!</div>
    <div style="font-size:13px;color:#6B7280;margin-top:4px">Отличная работа команды</div>
  </div>`}
  <div style="background:#fff;border:1px solid #E4E6EF;border-top:none;border-radius:0 0 12px 12px;padding:20px 28px;text-align:center">
    <a href="${dashboardUrl}" style="display:inline-block;background:#C53B2F;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;letter-spacing:0.3px">
      Открыть дашборд →
    </a>
    <div style="font-size:12px;color:#9CA3AF;margin-top:12px">Автоотчёт отправляется ежедневно в 18:00 по Астане</div>
  </div>
</div>
</body>
</html>`;

  try {
    const subject = `📊 ${unansweredCount > 0 ? `⚠️ ${unansweredCount} без ответа` : '✅ Все отвечено'} · Отчёт ${today}`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'ProLabSupport Mail Tracker <noreply@prolabsupport.kz>', to: recipients, subject, html }),
    });
    if (!res.ok) console.error('Email report error:', await res.text());
    else console.log('📧 Отчёт отправлен на:', recipients.join(', '));
  } catch (e) {
    console.error('Email report error:', e.message);
  }
}

module.exports = { sendEmailReport };

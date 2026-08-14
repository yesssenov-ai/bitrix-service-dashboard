// Handles sending client correspondence from a specific заявка (ticket),
// as a shared ProLabSupport service identity — with a company signature
// (showing the individual engineer's name/title) auto-appended, and a
// Reply-To alias so client replies land in a ticket-specific tracking
// address we can poll and match back, regardless of which engineer sends.
//
// Sends via Resend's HTTPS API rather than raw SMTP: Railway blocks
// outbound SMTP ports (465/587/25) on all plans below Pro specifically to
// prevent spam abuse (confirmed — this is why sends were hanging/timing
// out). Resend goes over HTTPS (443), which is never blocked, and since
// prolabsupport.kz is already a verified sending domain here (used
// elsewhere in this project for reports), any @prolabsupport.kz address
// can be used as the From — no per-engineer app password needed.
const { pool } = require('./auth');

const RESEND_KEY = process.env.RESEND_API_KEY;
const REPLY_TO_DOMAIN = 'prolabsupport.kz';
const LOGO_URL = 'https://nms.prolabsupport.kz/assets/company-full-logo.png';

function replyToForTicket(ticketId) {
  return `svc-${ticketId}@${REPLY_TO_DOMAIN}`;
}

function buildSignatureHtml(engineerName, jobTitle, mobilePhone) {
  const titleLine = jobTitle ? `<div>${escapeHtml(jobTitle)}</div>` : '';
  const mobileLine = mobilePhone ? `<div>m: ${escapeHtml(mobilePhone)}</div>` : '';
  return `
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #ccc;font-family:Arial,sans-serif;font-size:13px;color:#333;line-height:1.5;">
      <div style="color:#666;margin-bottom:10px;">Құрметпен \\ с уважением \\ regards,</div>
      <div style="font-weight:600">${escapeHtml(engineerName)}</div>
      ${titleLine}
      <div style="margin-top:8px">Kazakhstan, Astana city,</div>
      <div>55\\22 Mangilik El ave, EXPO-2017</div>
      <div style="margin-top:8px">T: +7 7172 73 49 30</div>
      ${mobileLine}
      <div style="margin-top:8px"><a href="https://www.prolabsupport.kz" style="color:#C53B2F">www.prolabsupport.kz</a></div>
      <img src="${LOGO_URL}" alt="ProLabSupport" width="460" style="width:460px;max-width:100%;height:auto;margin-top:14px;display:block;">
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateMessageId(ticketId) {
  return `<ticket-${ticketId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${REPLY_TO_DOMAIN}>`;
}

// Sends an email as a shared "ProLabSupport Service" identity (the client
// always sees a consistent sender, regardless of which engineer replies),
// while the signature shows the actual engineer's name so the client still
// knows who's helping. Returns the sent message details.
// Threading: looks up the most recent message on this ticket (sent OR
// received, by ANY engineer) and chains In-Reply-To/References to it, so
// the client's own mail client (Outlook etc.) groups the whole exchange as
// one conversation.
async function sendTicketEmail({ ticketId, engineerUserId, engineerEmail, engineerName, to, cc, subject, bodyHtml }) {
  if (!RESEND_KEY) {
    const err = new Error('Отправка почты не настроена (нет RESEND_API_KEY)');
    err.code = 'NO_RESEND_KEY';
    throw err;
  }

  const { rows } = await pool.query('SELECT job_title, mobile_phone FROM ticketsmodule_users WHERE id=$1', [engineerUserId]);
  const jobTitle = rows[0]?.job_title;
  const mobilePhone = rows[0]?.mobile_phone;

  // Find the last message in this ticket's thread (whoever sent/received it)
  const { rows: lastRows } = await pool.query(
    'SELECT message_id, references_header FROM ticketsmodule_ticket_emails WHERE ticket_id=$1 ORDER BY created_at DESC LIMIT 1',
    [ticketId]
  );
  const last = lastRows[0];
  const isFollowUp = !!last?.message_id;
  const references = isFollowUp
    ? [last.references_header, last.message_id].filter(Boolean).join(' ')
    : null;
  const threadedSubject = isFollowUp && !/^re:/i.test(subject) ? `Re: ${subject}` : subject;
  const messageId = generateMessageId(ticketId);

  const fullHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${escapeHtml(bodyHtml)}</div>${buildSignatureHtml(engineerName, jobTitle, mobilePhone)}`;

  const headers = { 'Message-ID': messageId };
  if (isFollowUp) {
    headers['In-Reply-To'] = last.message_id;
    headers['References'] = references;
  }

  const ccList = Array.isArray(cc) ? cc.filter(Boolean) : (cc ? String(cc).split(',').map(s => s.trim()).filter(Boolean) : []);

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'ProLabSupport Service <service@prolabsupport.kz>',
      to,
      ...(ccList.length ? { cc: ccList } : {}),
      reply_to: replyToForTicket(ticketId),
      subject: threadedSubject,
      html: fullHtml,
      headers,
    }),
  });
  if (!resendRes.ok) {
    const errText = await resendRes.text().catch(() => '');
    throw new Error(`Не удалось отправить письмо: ${errText || resendRes.status}`);
  }

  await pool.query(
    `INSERT INTO ticketsmodule_ticket_emails
      (ticket_id, direction, from_address, to_address, cc_address, subject, body_text, body_html, sender_user_id, message_id, references_header)
     VALUES ($1,'sent',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [ticketId, engineerEmail, to, ccList.length ? ccList.join(', ') : null, threadedSubject, bodyHtml, fullHtml, engineerUserId, messageId, references]
  );

  return { messageId };
}

async function getTicketEmails(ticketId) {
  const { rows } = await pool.query(
    'SELECT * FROM ticketsmodule_ticket_emails WHERE ticket_id=$1 ORDER BY created_at ASC',
    [ticketId]
  );
  return rows;
}

module.exports = { sendTicketEmail, getTicketEmails, replyToForTicket };

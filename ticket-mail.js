// Handles sending client correspondence from a specific заявка (ticket),
// as the assigned engineer's own corporate Yandex 360 mailbox — with a
// company signature auto-appended, and a Reply-To alias so client replies
// land in a ticket-specific tracking address we can poll and match back.
const nodemailer = require('nodemailer');
const { pool } = require('./auth');
const { decrypt } = require('./crypto-helper');

const REPLY_TO_DOMAIN = 'prolabsupport.kz';
const LOGO_URL = 'https://nms.prolabsupport.kz/assets/company-full-logo.png';

function replyToForTicket(ticketId) {
  return `svc-${ticketId}@${REPLY_TO_DOMAIN}`;
}

function buildSignatureHtml(engineerName) {
  return `
    <div style="margin-top:24px;padding-top:16px;border-top:2px solid #C53B2F;font-family:Arial,sans-serif;font-size:13px;color:#333;">
      <img src="${LOGO_URL}" alt="ProLabSupport" style="height:32px;margin-bottom:8px;display:block;">
      <div style="font-weight:600">${escapeHtml(engineerName)}</div>
      <div style="color:#666">ProLabSupport · Quality, confidence, culture!</div>
      <div style="color:#666;margin-top:4px">+7 7172 73 49 30 · sales@prolabsupport.kz</div>
      <div style="color:#999;font-size:11px">Astana, 55\\22 Mangilik El ave, EXPO-2017</div>
    </div>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Sends an email as the given engineer (their own Yandex 360 mailbox,
// via a stored app password) and returns the sent message details.
// Threading: looks up the most recent message on this ticket (sent OR
// received, by ANY engineer) and chains In-Reply-To/References to it, so
// the client's own mail client (Outlook etc.) groups the whole exchange as
// one conversation — independent of which engineer sends each message.
async function sendTicketEmail({ ticketId, engineerUserId, engineerEmail, engineerName, to, subject, bodyHtml }) {
  const { rows } = await pool.query('SELECT smtp_app_password_encrypted FROM ticketsmodule_users WHERE id=$1', [engineerUserId]);
  const encrypted = rows[0]?.smtp_app_password_encrypted;
  if (!encrypted) {
    const err = new Error('У вас не настроен пароль приложения для отправки почты — задайте его в настройках');
    err.code = 'NO_APP_PASSWORD';
    throw err;
  }
  const appPassword = decrypt(encrypted);

  // Find the last message in this ticket's thread (whoever sent/received it)
  const { rows: lastRows } = await pool.query(
    'SELECT message_id, references_header, subject FROM ticketsmodule_ticket_emails WHERE ticket_id=$1 ORDER BY created_at DESC LIMIT 1',
    [ticketId]
  );
  const last = lastRows[0];
  const isFollowUp = !!last?.message_id;
  const references = isFollowUp
    ? [last.references_header, last.message_id].filter(Boolean).join(' ')
    : null;
  const threadedSubject = isFollowUp && !/^re:/i.test(subject) ? `Re: ${subject}` : subject;

  const transporter = nodemailer.createTransport({
    host: 'smtp.yandex.ru',
    port: 465,
    secure: true,
    auth: { user: engineerEmail, pass: appPassword },
  });

  const fullHtml = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;white-space:pre-wrap">${escapeHtml(bodyHtml)}</div>${buildSignatureHtml(engineerName)}`;

  const mailOptions = {
    from: `"${engineerName}" <${engineerEmail}>`,
    to,
    replyTo: replyToForTicket(ticketId),
    subject: threadedSubject,
    html: fullHtml,
  };
  if (isFollowUp) {
    mailOptions.inReplyTo = last.message_id;
    mailOptions.references = references;
  }

  const info = await transporter.sendMail(mailOptions);

  await pool.query(
    `INSERT INTO ticketsmodule_ticket_emails
      (ticket_id, direction, from_address, to_address, subject, body_text, body_html, sender_user_id, message_id, references_header)
     VALUES ($1,'sent',$2,$3,$4,$5,$6,$7,$8,$9)`,
    [ticketId, engineerEmail, to, threadedSubject, bodyHtml, fullHtml, engineerUserId, info.messageId, references]
  );

  return { messageId: info.messageId };
}

async function getTicketEmails(ticketId) {
  const { rows } = await pool.query(
    'SELECT * FROM ticketsmodule_ticket_emails WHERE ticket_id=$1 ORDER BY created_at ASC',
    [ticketId]
  );
  return rows;
}

module.exports = { sendTicketEmail, getTicketEmails, replyToForTicket };

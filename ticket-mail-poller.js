// Polls the "lost mail" catch-all inbox (support@prolabsupport.kz, per
// Yandex 360's "Ящик для потерянных писем" setting) for client replies to
// the svc-{ticketId}@... Reply-To alias set on outbound ticket emails.
// Matches by ticket ID embedded in the address (not subject — more
// reliable), stores the reply, and writes it into Bitrix's Timeline so it
// shows up alongside everything else on the заявка.
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { pool } = require('./auth');
const { b24 } = require('./bitrix');

let isPolling = false;
let isFirstPoll = true;

function getConfig() {
  const user = process.env.TICKET_MAIL_IMAP_USER;
  const password = process.env.TICKET_MAIL_IMAP_PASS;
  if (!user || !password) return null;
  return {
    user, password,
    host: process.env.TICKET_MAIL_IMAP_HOST || 'imap.yandex.ru',
    port: parseInt(process.env.TICKET_MAIL_IMAP_PORT || '993'),
  };
}

function openBox(imap, boxName) {
  return new Promise((resolve, reject) => {
    imap.openBox(boxName, true, (err, box) => err ? reject(err) : resolve(box));
  });
}
function searchMessages(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, results) => err ? reject(err) : resolve(results || []));
  });
}

// Extracts the ticket ID from a svc-{id}@domain address among the message's
// To/Cc recipients (the client's mail client puts the original Reply-To
// address here when they hit "Reply").
function extractTicketId(parsed) {
  const allAddrs = [
    ...(parsed.to?.value || []),
    ...(parsed.cc?.value || []),
  ].map(a => (a.address || '').toLowerCase());
  for (const addr of allAddrs) {
    const m = addr.match(/^svc-(\d+)@/);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

function joinReferences(parsed) {
  const refs = parsed.references;
  if (!refs) return null;
  return Array.isArray(refs) ? refs.join(' ') : String(refs);
}

// Mail clients (Outlook, Gmail, etc.) auto-append the entire quoted
// previous message when someone hits "Reply" — without this, a long-running
// thread would show the full accumulated history inside every single
// message bubble in the dashboard, since we already display history via
// separate bubbles per message. This trims everything from the first
// recognized quote marker onward, keeping just the new reply text.
function stripQuotedReply(text) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const markers = [
    /^From:\s.+/i, /^От:\s.+/i,
    /^-----Original Message-----/i, /^---------- Forwarded message/i,
    /^On .+ wrote:$/i, /^В .+ (написал|написала|писал\(а\)):$/iu,
    /^\d{1,2}[.,]\s?\w+[.,]?\s?\d{4}.*(писал|wrote)/iu,
    /^(Пн|Вт|Ср|Чт|Пт|Сб|Вс),\s.+\d{4}.*(в|at)\s.*(писал|wrote)/iu,
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (markers.some(re => re.test(line))) {
      const cleaned = lines.slice(0, i).join('\n').trim();
      return cleaned || text.trim(); // fall back to full text if nothing but quote remains
    }
    if (line.startsWith('>') && i > 0) {
      const cleaned = lines.slice(0, i).join('\n').trim();
      return cleaned || text.trim();
    }
  }
  return text.trim();
}

async function alreadyStored(messageId) {
  if (!messageId) return false;
  const { rows } = await pool.query('SELECT 1 FROM ticketsmodule_ticket_emails WHERE message_id=$1 LIMIT 1', [messageId]);
  return rows.length > 0;
}

async function processMessage(parsed) {
  const ticketId = extractTicketId(parsed);
  if (!ticketId) return; // genuinely a typo/misdirected email, not a ticket reply — ignore

  const messageId = parsed.messageId || null;
  if (await alreadyStored(messageId)) return;

  const fromAddr = parsed.from?.value?.[0]?.address || '';
  const subject = parsed.subject || '(без темы)';
  const bodyText = stripQuotedReply(parsed.text || '');
  const bodyHtml = parsed.html || parsed.textAsHtml || '';
  const references = joinReferences(parsed);

  await pool.query(
    `INSERT INTO ticketsmodule_ticket_emails
      (ticket_id, direction, from_address, to_address, subject, body_text, body_html, message_id, references_header)
     VALUES ($1,'received',$2,$3,$4,$5,$6,$7,$8)`,
    [ticketId, fromAddr, `svc-${ticketId}@prolabsupport.kz`, subject, bodyText, bodyHtml, messageId, references]
  );

  await b24('crm.timeline.comment.add', {
    fields: { ENTITY_ID: ticketId, ENTITY_TYPE: 'dynamic_1058', COMMENT: `📩 Ответ от ${fromAddr}\n${subject}\n\n${bodyText.slice(0, 2000)}` }
  }).catch(e => console.error(`ticket-mail-poller: Bitrix Timeline write failed for ticket #${ticketId}:`, e.message));

  console.log(`📩 [ticket-mail] Заявка #${ticketId}: ответ от ${fromAddr} сохранён`);
}

function processOneBatch(imap, uids) {
  return new Promise((resolve) => {
    if (!uids.length) return resolve();
    let processed = 0;
    const total = uids.length;
    const f = imap.fetch(uids, { bodies: '' });

    f.on('message', (msg) => {
      let buffer = '';
      msg.on('body', (stream) => {
        stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
        stream.once('end', async () => {
          try {
            const parsed = await simpleParser(buffer);
            buffer = '';
            await processMessage(parsed);
          } catch (e) {
            console.error('ticket-mail-poller parse error:', e.message);
          } finally {
            processed++;
            if (processed === total) resolve();
          }
        });
      });
    });

    f.once('error', (err) => { console.error('ticket-mail-poller fetch error:', err.message); resolve(); });
    f.once('end', () => { setTimeout(() => { if (processed < total) resolve(); }, 3000); });
  });
}

async function pollTicketMailbox() {
  if (isPolling) return;
  const config = getConfig();
  if (!config) return; // not configured yet
  isPolling = true;

  const since = new Date();
  if (isFirstPoll) { since.setDate(since.getDate() - 10); isFirstPoll = false; }
  else { since.setMinutes(since.getMinutes() - 15); }

  const imap = new Imap({
    user: config.user, password: config.password, host: config.host, port: config.port,
    tls: true, tlsOptions: { rejectUnauthorized: true },
    authTimeout: 15000, connTimeout: 20000, keepalive: false,
  });

  await new Promise((resolve) => {
    imap.once('ready', async () => {
      try {
        await openBox(imap, 'INBOX');
        const uids = await searchMessages(imap, [['SINCE', since]]);
        console.log(`📬 [ticket-mail] INBOX: ${uids.length} писем к проверке`);
        const BATCH = 5;
        for (let i = 0; i < uids.length; i += BATCH) {
          await processOneBatch(imap, uids.slice(i, i + BATCH));
          await new Promise(r => setTimeout(r, 200));
        }
        console.log('✅ [ticket-mail] Polling завершён');
      } catch (err) {
        console.error('❌ [ticket-mail] Error:', err.message);
      } finally {
        imap.end();
        isPolling = false;
        resolve();
      }
    });
    imap.once('error', (err) => {
      console.error('IMAP [ticket-mail] connection error:', err.message);
      isPolling = false;
      resolve();
    });
    imap.connect();
  });
}

module.exports = { pollTicketMailbox };

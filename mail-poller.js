const Imap = require('imap');
const { simpleParser } = require('mailparser');
const mailLib = require('./mail-lib');

let isPolling = false;
let isFirstPoll = true;

function getMailboxConfigs() {
  const configs = [];
  if (process.env.MAIL_IMAP_USER && process.env.MAIL_IMAP_PASS) {
    configs.push({ mailbox: 'service', user: process.env.MAIL_IMAP_USER, password: process.env.MAIL_IMAP_PASS, host: process.env.MAIL_IMAP_HOST || 'imap.yandex.ru', port: parseInt(process.env.MAIL_IMAP_PORT || '993') });
  }
  if (process.env.MAIL_ORDERS_IMAP_USER && process.env.MAIL_ORDERS_IMAP_PASS) {
    configs.push({ mailbox: 'orders', user: process.env.MAIL_ORDERS_IMAP_USER, password: process.env.MAIL_ORDERS_IMAP_PASS, host: 'imap.yandex.ru', port: 993 });
  }
  if (process.env.MAIL_SALES_IMAP_USER && process.env.MAIL_SALES_IMAP_PASS) {
    configs.push({ mailbox: 'sales', user: process.env.MAIL_SALES_IMAP_USER, password: process.env.MAIL_SALES_IMAP_PASS, host: 'imap.yandex.ru', port: 993 });
  }
  if (process.env.MAIL_TRAINING_IMAP_USER && process.env.MAIL_TRAINING_IMAP_PASS) {
    configs.push({ mailbox: 'training', user: process.env.MAIL_TRAINING_IMAP_USER, password: process.env.MAIL_TRAINING_IMAP_PASS, host: 'imap.yandex.ru', port: 993 });
  }
  return configs;
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

// Parse one email at a time and process it right away — don't hold it all in memory
function processOneBatch(imap, uids, mailbox, ourEmail, ourDomain) {
  return new Promise((resolve, reject) => {
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
            await processEmail(parsed, mailbox, ourEmail, ourDomain);
          } catch (e) {
            console.error(`Parse error [${mailbox}]:`, e.message);
          } finally {
            processed++;
            if (processed === total) resolve();
          }
        });
      });
    });

    f.once('error', (err) => { console.error('Fetch error:', err.message); resolve(); });
    f.once('end', () => { setTimeout(() => { if (processed < total) resolve(); }, 3000); });
  });
}

async function processEmail(parsed, mailbox, ourEmail, ourDomain) {
  const messageId = parsed.messageId || `noId-${Date.now()}-${Math.random()}`;
  const inReplyTo = parsed.inReplyTo || null;

  if (inReplyTo) {
    const original = await mailLib.findByMessageId(inReplyTo);
    if (original && !original.answered) {
      const answeredBy = parsed.from?.value?.[0]?.address || 'unknown';
      await mailLib.markAnswered(answeredBy, inReplyTo, (parsed.text || '').slice(0, 2000), parsed.subject || '');
    }
    return;
  }

  const subject = parsed.subject || '';
  const subjectLower = subject.toLowerCase();
  const isReplySubject = subjectLower.startsWith('re:') || subjectLower.startsWith('fw:') || subjectLower.startsWith('fwd:');

  if (isReplySubject) {
    const cleanSubject = subject.replace(/^(re|fw|fwd):\s*/gi, '').trim();
    if (cleanSubject) {
      const threadOriginal = await mailLib.findBySubject(cleanSubject);
      if (threadOriginal && !threadOriginal.answered) {
        await mailLib.markAnswered(parsed.from?.value?.[0]?.address || 'unknown', threadOriginal.message_id, (parsed.text || '').slice(0, 2000), subject);
      }
    }
    return;
  }

  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();

  if (['noreply', 'no-reply', 'n8n@', 'newsletter', 'mailer-daemon', 'id.yandex'].some(s => fromAddr.includes(s))) return;

  if (fromAddr.endsWith('@' + ourDomain)) {
    const toRecipients = (parsed.to?.value || []).map(r => (r.address || '').toLowerCase());
    const hasExternalRecipient = toRecipients.some(addr => !addr.endsWith('@' + ourDomain));
    if (hasExternalRecipient) return;
  }

  const { category, source } = await mailLib.classify({ from_addr: fromAddr, subject: parsed.subject || '' });

  await mailLib.upsertEmail({
    id: messageId,
    message_id: messageId,
    in_reply_to: inReplyTo,
    from_addr: fromAddr,
    from_name: parsed.from?.value?.[0]?.name || '',
    subject: parsed.subject || '(без темы)',
    received_at: (parsed.date || new Date()).toISOString(),
    category,
    category_source: source,
    body_preview: (parsed.text || '').slice(0, 300),
    mailbox,
  });
}

async function pollMailbox(config, since) {
  const { mailbox, user, password, host, port } = config;
  const ourEmail = user.toLowerCase();
  const ourDomain = ourEmail.split('@')[1] || '';

  const imap = new Imap({
    user, password, host, port,
    tls: true, tlsOptions: { rejectUnauthorized: true },
    authTimeout: 15000, connTimeout: 20000, keepalive: false,
  });

  await new Promise((resolve) => {
    imap.once('ready', async () => {
      try {
        const folders = ['INBOX', 'Отправленные', 'Sent'];
        for (const folder of folders) {
          try {
            await openBox(imap, folder);
            const uids = await searchMessages(imap, [['SINCE', since]]);
            console.log(`📬 [${mailbox}] ${folder}: ${uids.length} писем`);
            if (!uids.length) continue;

            const BATCH = 5;
            for (let i = 0; i < uids.length; i += BATCH) {
              const batch = uids.slice(i, i + BATCH);
              await processOneBatch(imap, batch, mailbox, ourEmail, ourDomain);
              await new Promise(r => setTimeout(r, 200));
            }
          } catch (e) {
            console.log(`📁 [${mailbox}] Папка ${folder} не найдена`);
          }
        }
        console.log(`✅ [${mailbox}] Polling завершён`);
      } catch (err) {
        console.error(`❌ [${mailbox}] Error:`, err.message);
      } finally {
        imap.end();
        resolve();
      }
    });

    imap.once('error', (err) => {
      console.error(`IMAP [${mailbox}] connection error:`, err.message);
      resolve();
    });

    imap.connect();
  });
}

async function pollInbox() {
  if (isPolling) return;
  isPolling = true;

  const since = new Date();
  if (isFirstPoll) {
    since.setDate(since.getDate() - 10);
    console.log('🔄 Первый запуск — загружаем 10 дней');
    isFirstPoll = false;
  } else {
    since.setDate(since.getDate() - 1);
  }

  const configs = getMailboxConfigs();
  console.log(`📮 Polling ${configs.length} ящиков...`);

  for (const config of configs) {
    try {
      await pollMailbox(config, since);
    } catch (e) {
      console.error(`❌ Ошибка polling [${config.mailbox}]:`, e.message);
    }
  }

  isPolling = false;
}

module.exports = { pollInbox };

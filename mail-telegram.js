const MAIL_TG_TOKEN = process.env.MAIL_TELEGRAM_TOKEN;
const MAIL_TG_CHAT_ID = process.env.MAIL_TELEGRAM_CHAT_ID;

async function sendMailTelegram(text) {
  if (!MAIL_TG_TOKEN || !MAIL_TG_CHAT_ID) {
    console.log('Mail Telegram не настроен, пропускаем');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${MAIL_TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: MAIL_TG_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('Mail Telegram error:', await res.text());
  } catch (e) {
    console.error('Mail Telegram send failed:', e.message);
  }
}

async function notifyPendingEmails(emails) {
  if (!emails.length) return;
  const lines = emails.map(e => {
    const from = e.from_name || e.from_addr;
    const subj = e.subject || '(без темы)';
    const mins = Math.floor((Date.now() - new Date(e.received_at).getTime()) / 60000);
    return `• <b>${subj}</b>\n  От: ${from} | Ждёт: ${mins} мин`;
  });
  const text = `🚨 <b>Нет ответа на письма клиентов!</b>\n\n${lines.join('\n\n')}`;
  await sendMailTelegram(text);
}

async function sendDailyDigest(stats) {
  const text =
    `📊 <b>Дайджест за сегодня (почта)</b>\n\n` +
    `📨 Всего писем: ${stats.total}\n` +
    `✅ Отвечено: ${stats.answered}\n` +
    `⏳ Клиенты без ответа: ${stats.pending_client}\n` +
    `🟢 Клиенты: ${stats.client}\n` +
    `📋 Тендеры: ${stats.tender}\n` +
    `📢 Реклама: ${stats.adv}\n` +
    `🗑 Спам: ${stats.spam}\n` +
    `❓ Без категории: ${stats.uncategorized}`;
  await sendMailTelegram(text);
}

module.exports = { sendMailTelegram, notifyPendingEmails, sendDailyDigest };

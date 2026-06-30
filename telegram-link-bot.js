const fetch = require('node-fetch');

const TG_TOKEN = process.env.TG_TOKEN;
let lastUpdateId = 0;
let pool = null;

function setPool(p) { pool = p; }

async function pollTelegramUpdates() {
  if (!TG_TOKEN || !pool) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=0`);
    const data = await res.json();
    if (!data.ok) return;

    for (const update of data.result) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      const msg = update.message;
      if (!msg || !msg.text) continue;

      const text = msg.text.trim();
      const match = text.match(/^\/start\s+(\d+)$/);
      if (match) {
        const bitrixUserId = parseInt(match[1]);
        const chatId = msg.chat.id;
        const username = msg.from?.username || msg.from?.first_name || '';

        try {
          await pool.query(
            `INSERT INTO ticketsmodule_telegram_links (bitrix_user_id, telegram_chat_id, telegram_username)
             VALUES ($1, $2, $3)
             ON CONFLICT (bitrix_user_id) DO UPDATE SET telegram_chat_id=$2, telegram_username=$3, linked_at=NOW()`,
            [bitrixUserId, chatId, username]
          );
          await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: '✅ Готово! Теперь вы будете получать персональные уведомления о ваших сделках в ProLabSupport.',
            }),
          });
          console.log(`✅ Telegram linked: bitrix user ${bitrixUserId} -> chat ${chatId}`);
        } catch(e) {
          console.error('Telegram link save error:', e.message);
        }
      }
    }
  } catch(e) {
    console.error('pollTelegramUpdates error:', e.message);
  }
}

function startPolling(intervalMs = 15000) {
  pollTelegramUpdates();
  setInterval(pollTelegramUpdates, intervalMs);
}

module.exports = { setPool, startPolling, pollTelegramUpdates };

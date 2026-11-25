// ВЫКЛЮЧЕНО. Старая привязка «/start <bitrix_user_id>» небезопасна: id сотрудника
// Bitrix не секрет, и любой мог привязать себе чужие уведомления. Теперь Telegram
// обслуживает tg-bot.js (привязка по одноразовому коду из профиля ЦУП).
// Модуль оставлен пустым, чтобы старые require не падали.
function setPool() {}
function startPolling() { console.warn('telegram-link-bot: выключен, используется tg-bot.js'); }
async function pollTelegramUpdates() {}
module.exports = { setPool, startPolling, pollTelegramUpdates };

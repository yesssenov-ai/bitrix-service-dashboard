// Автор комментариев, которые ЦУП пишет в таймлайн Битрикса.
//
// Битрикс при записи через вебхук ВСЕГДА ставит автором владельца вебхука
// (поле AUTHOR_ID в crm.timeline.comment.add игнорируется). Поэтому настоящего
// автора пишем в начало текста: «[Имя Фамилия]: текст», а при чтении ленты в ЦУП
// достаём его обратно и показываем вместо владельца вебхука.
const WEBHOOK_UID = (() => {
  const m = String(process.env.BITRIX_WEBHOOK || '').match(/\/rest\/(\d+)\//);
  return m ? m[1] : null;
})();

function whoOf(user) {
  return String((user && (user.display_name || user.engineer_name || user.username)) || 'сотрудник ЦУП').trim();
}

// Текст для записи в Битрикс.
function authored(user, text) {
  return `[${whoOf(user)}]: ${String(text || '').trim()}`;
}

// Разбор при чтении: { name|null, text } — name найден, если комментарий записан ЦУПом.
// «[Имя]: …» — текущий формат; «💬 Имя: …» — старый формат «Реализации» (только у
// комментариев владельца вебхука, чтобы не путать с обычными комментариями людей).
const RE_NEW = /^\s*\[([^\[\]\n]{2,80})\]:\s*/;
const RE_OLD = /^\s*💬\s*([^:\n]{2,60}):\s*/;
function splitAuthored(comment, authorId) {
  const s = String(comment || '');
  let m = s.match(RE_NEW);
  if (m && !/^\/?[A-Z]+(=[^\]]*)?$/.test(m[1])) return { name: m[1].trim(), text: s.slice(m[0].length) }; // не BB-код вида [B]
  const fromWebhook = !WEBHOOK_UID || String(authorId || '') === WEBHOOK_UID;
  if (fromWebhook && (m = s.match(RE_OLD))) return { name: m[1].trim(), text: s.slice(m[0].length) };
  return { name: null, text: s };
}

module.exports = { WEBHOOK_UID, whoOf, authored, splitAuthored };

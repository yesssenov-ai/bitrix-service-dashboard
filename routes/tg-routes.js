// Вебхук Telegram-бота ЦУП. Отвечаем 200 СРАЗУ, работаем потом: Telegram ждёт
// ~10 с и повторяет доставку, а агент думает дольше — иначе на один вопрос
// придёт три ответа (и три счёта за токены). Повторы отсекаются в tg-bot по update_id.
const crypto = require('crypto');
const router = require('express').Router();

function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

router.post('/hook', (req, res) => {
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (!secret || !sameSecret(req.get('x-telegram-bot-api-secret-token'), secret)) return res.sendStatus(401);
  res.json({ ok: true });                                   // ← 200 ДО работы; дальше к res не прикасаемся
  require('../tg-bot').handle(req.body).catch(e => console.error('[tg] разбор упал:', e.message));
});

module.exports = router;

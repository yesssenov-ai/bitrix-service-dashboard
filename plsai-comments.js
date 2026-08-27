// ProLab AI — общий модуль по комментариям сделок: дата последнего комментария +
// смысловой сигнал (близко к подписанию / застряло). Кэш 6ч в отдельной таблице.
const { pool } = require('./auth');

// «Близко к подписанию» ↑ / «застряло» ↓. Кириллица через [а-яё], без латинского \w.
const NEAR_RE = /на подписани|отправил[а-яё]* на подпис|жд[ёе]м подписани|готов[а-яё]* к подписани|подписыва[а-яё]* договор|подписал[а-яё]* договор|подписание договор|сч[ёе]т на подпис|оплата получ|оплат[а-яё]* поступ|тендер выигра|выигра[а-яё]* тендер|выбрали нас|нас выбрали|мы выигра|нас выигра/;
const STALL_RE = /в ожидани|ожида[ею]м реш|пока\b|перенес|отлож|заморож|нет бюджет|бюджет не|проигра|отказ|отмен|сорвал|заглох|не выход[а-яё]* на связ|тишина|приостанов|на согласовани|на рассмотрени|думают|не готов|не подтверд/;

let _ready = false;
async function ensure() {
  if (_ready) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_plsai_comment_meta (
      deal_id INTEGER PRIMARY KEY, signal VARCHAR(12), snippet TEXT, last_comment_at TIMESTAMPTZ, checked_at TIMESTAMPTZ DEFAULT NOW())`);
    _ready = true;
  } catch (_) {}
}

// Возвращает { signal, snippet, lastAt } по сделке (кэш 6ч).
async function commentMeta(dealId) {
  await ensure();
  try {
    const { rows } = await pool.query("SELECT signal, snippet, last_comment_at FROM ticketsmodule_plsai_comment_meta WHERE deal_id=$1 AND checked_at > NOW() - INTERVAL '6 hours'", [dealId]);
    if (rows.length) return { signal: rows[0].signal, snippet: rows[0].snippet || '', lastAt: rows[0].last_comment_at || null };
  } catch (_) {}
  let signal = 'neutral', snippet = '', lastAt = null;
  try {
    const { b24 } = require('./bitrix');
    const { result } = await b24('crm.timeline.comment.list', { filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' }, order: { CREATED: 'DESC' }, select: ['COMMENT', 'CREATED'] });
    const arr = result || [];
    if (arr[0] && arr[0].CREATED) lastAt = arr[0].CREATED;
    const texts = arr.slice(0, 6).map(c => String(c.COMMENT || ''));
    const joined = texts.join(' \n ').toLowerCase();
    if (STALL_RE.test(joined)) { signal = 'stall'; snippet = (texts.find(t => STALL_RE.test(t.toLowerCase())) || '').replace(/\s+/g, ' ').trim().slice(0, 180); }
    else if (NEAR_RE.test(joined)) { signal = 'near'; snippet = (texts.find(t => NEAR_RE.test(t.toLowerCase())) || '').replace(/\s+/g, ' ').trim().slice(0, 180); }
  } catch (_) {}
  try { await pool.query(`INSERT INTO ticketsmodule_plsai_comment_meta (deal_id,signal,snippet,last_comment_at,checked_at) VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (deal_id) DO UPDATE SET signal=$2, snippet=$3, last_comment_at=$4, checked_at=NOW()`, [dealId, signal, snippet, lastAt]); } catch (_) {}
  return { signal, snippet, lastAt };
}

async function mapLimit(items, limit, fn) {
  const out = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; try { out[idx] = await fn(items[idx], idx); } catch (_) { out[idx] = null; } } });
  await Promise.all(workers); return out;
}

module.exports = { commentMeta, mapLimit, NEAR_RE, STALL_RE };

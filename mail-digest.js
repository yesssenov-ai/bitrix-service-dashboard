// Ежедневная сводка по ЛИЧНОЙ почте Google в Telegram (ProLab AI).
//
// Не «список всех писем», а то, с чем надо что-то сделать:
//   • сколько пришло за сутки и сколько не прочитано;
//   • с каких адресов групп (sales@, info@ …) — письмо группы лежит в личном ящике
//     участника с адресом группы в To/Cc;
//   • кто писал чаще всех;
//   • без ответа дольше суток (последнее письмо в переписке — не от меня, 1–7 дней);
//   • непрочитанные за сутки — первые несколько.
//
// Время у каждого своё (ticketsmodule_user_google.digest_at, по Казахстану, будни),
// защита от повтора — digest_sent (дата). Вызывается из существующего планировщика
// в server.js (тот же 5-минутный цикл, что и утренняя сводка), второго расписания нет.
// Ничего из писем не сохраняется: считаем на лету и отправляем.
const { pool } = require('./auth');

const KZ_MS = 5 * 3600e3;
const nowKz = () => new Date(Date.now() + KZ_MS);
const NOISE = '-category:promotions -category:social -category:forums -in:chats -in:spam -in:trash';
const MAX_DAY = 300;          // писем за сутки на разбор заголовков
const MAX_THREADS = 40;       // переписок на проверку «без ответа»

const emailOf = s => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const nameOf = s => { const t = String(s || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim(); return t || emailOf(s); };
const addrList = s => String(s || '').split(',').map(emailOf).filter(x => x.includes('@'));
const ago = ms => { const d = Math.floor(ms / 86400e3); return d >= 1 ? `${d} дн.` : `${Math.max(1, Math.floor(ms / 3600e3))} ч`; };
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function ensure() {
  await require('./gmail-lib').ensure();
  await pool.query(`ALTER TABLE ticketsmodule_user_google ADD COLUMN IF NOT EXISTS digest_weekdays BOOLEAN DEFAULT TRUE`).catch(() => {});
}

// Собрать данные сводки для одного сотрудника.
async function collect(userId) {
  const gm = require('./gmail-lib');
  const { token, email } = await gm.accessToken(userId);
  const domain = email.split('@')[1] || '';

  // 1) Входящие за сутки (кроме рекламы/соцсетей) — заголовки пачкой.
  const day = await gm.listIds(token, `newer_than:1d -from:me ${NOISE}`, MAX_DAY);
  const metas = (await gm.headersOf(token, day.ids.map(x => x.id), ['From', 'To', 'Cc', 'Subject'])).filter(m => m && !m.error);
  const unread = metas.filter(m => m.labels.includes('UNREAD'));

  // 2) Адреса групп: адреса нашего домена в To/Cc, кроме своего.
  const groups = {};
  for (const m of metas) {
    const seen = new Set();
    for (const a of addrList(m.to).concat(addrList(m.cc))) {
      if (a === email || seen.has(a) || !domain || !a.endsWith('@' + domain)) continue;
      seen.add(a); groups[a] = (groups[a] || 0) + 1;
    }
  }
  // 3) Кто писал чаще всех.
  const senders = {};
  for (const m of metas) { const k = emailOf(m.from); if (!senders[k]) senders[k] = { name: nameOf(m.from), n: 0 }; senders[k].n++; }

  // 4) Без ответа дольше суток: входящие 1–7 дней, последнее письмо переписки — не от меня.
  const old = await gm.listIds(token, `in:inbox -from:me older_than:1d newer_than:7d ${NOISE}`, 200);
  const threadIds = [...new Set(old.ids.map(x => x.threadId))].slice(0, MAX_THREADS);
  const waiting = [];
  for (const tid of threadIds) {
    try {
      const t = await gm.threadMeta(token, tid);
      const msgs = (t.messages || []).slice().sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      const last = msgs[msgs.length - 1];
      if (!last) continue;
      const lastFrom = emailOf(((last.payload && last.payload.headers) || []).find(h => String(h.name).toLowerCase() === 'from')?.value);
      if ((last.labelIds || []).includes('SENT') || lastFrom === email) continue;      // ответил я
      const first = msgs.find(x => !(x.labelIds || []).includes('SENT')) || last;
      const fh = (first.payload && first.payload.headers) || [];
      waiting.push({
        from: nameOf(((last.payload && last.payload.headers) || []).find(h => String(h.name).toLowerCase() === 'from')?.value),
        subject: (fh.find(h => String(h.name).toLowerCase() === 'subject') || {}).value || '(без темы)',
        age: Date.now() - Number(last.internalDate),
      });
    } catch (e) { /* переписку пропускаем */ }
  }
  waiting.sort((a, b) => b.age - a.age);

  return {
    email, received: metas.length, receivedCapped: day.capped, unread: unread.length,
    groups: Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 6),
    senders: Object.values(senders).sort((a, b) => b.n - a.n).filter(s => s.n > 1).slice(0, 5),
    waiting, waitingChecked: threadIds.length, waitingCapped: old.capped || threadIds.length >= MAX_THREADS,
    unreadTop: unread.sort((a, b) => b.at - a.at).slice(0, 5).map(m => ({ from: nameOf(m.from), subject: m.subject || '(без темы)' })),
  };
}

function build(name, d) {
  const L = [];
  L.push(`Почта за сутки · ${d.email}`);
  L.push(`Пришло: ${d.received}${d.receivedCapped ? '+' : ''} · не прочитано: ${d.unread}`);
  if (d.groups.length) L.push('Через группы: ' + d.groups.map(([a, n]) => `${a.split('@')[0]}@ — ${n}`).join(', '));
  if (d.senders.length) L.push('Чаще всех: ' + d.senders.map(s => `${cut(s.name, 30)} (${s.n})`).join(', '));
  if (d.waiting.length) {
    L.push('', `Без ответа больше суток: ${d.waiting.length}${d.waitingCapped ? ` (проверены последние ${d.waitingChecked} переписок)` : ''}`);
    d.waiting.slice(0, 7).forEach(w => L.push(`• ${cut(w.from, 30)} — «${cut(w.subject, 60)}» · ${ago(w.age)}`));
    if (d.waiting.length > 7) L.push(`…и ещё ${d.waiting.length - 7}`);
  }
  if (d.unreadTop.length) {
    L.push('', 'Не прочитано за сутки:');
    d.unreadTop.forEach(u => L.push(`• ${cut(u.from, 30)} — «${cut(u.subject, 60)}»`));
  }
  if (!d.received && !d.waiting.length) L.push('', 'Новых писем нет, неотвеченных переписок нет.');
  L.push('', 'Спросите меня: «перескажи письмо от …», «что ждёт ответа от клиентов».');
  return L.join('\n');
}

// Отправить сводку одному (по кнопке «Прислать сейчас» / команде /digest).
async function sendNow(userId) {
  await ensure();
  const u = (await pool.query('SELECT id, display_name, username, telegram_chat_id FROM ticketsmodule_users WHERE id=$1 AND active=true', [userId])).rows[0];
  if (!u) throw new Error('Пользователь не найден');
  if (!u.telegram_chat_id) throw new Error('Сначала подключите Telegram в профиле');
  const d = await collect(userId);
  await require('./tg-bot').say(u.telegram_chat_id, build(u.display_name || u.username, d));
  return { ok: true, received: d.received, waiting: d.waiting.length };
}

// Вызывается каждые 5 минут из планировщика: шлём тем, у кого наступило их время.
let _busy = false;
async function tick() {
  if (_busy || !require('./gmail-lib').configured()) return;
  _busy = true;
  try {
    await ensure();
    const now = nowKz();
    const today = now.toISOString().slice(0, 10);
    const hhmm = now.toISOString().slice(11, 16);
    const dow = now.getUTCDay();
    const { rows } = await pool.query(`
      SELECT g.id, g.user_id, g.digest_weekdays, u.display_name, u.username, u.telegram_chat_id
        FROM ticketsmodule_user_google g JOIN ticketsmodule_users u ON u.id = g.user_id AND u.active = true
       WHERE g.revoked_at IS NULL AND g.digest_at IS NOT NULL AND u.telegram_chat_id IS NOT NULL
         AND to_char(g.digest_at, 'HH24:MI') <= $1
         AND to_char(g.digest_at, 'HH24:MI') >= to_char(($1::time - INTERVAL '3 hours'), 'HH24:MI')
         AND (g.digest_sent IS NULL OR g.digest_sent < $2::date)`, [hhmm, today]);
    for (const r of rows) {
      if (r.digest_weekdays !== false && (dow === 0 || dow === 6)) continue;
      // Отмечаем ДО отправки: перезапуск процесса или сбой не пришлёт сводку дважды.
      await pool.query('UPDATE ticketsmodule_user_google SET digest_sent=$1 WHERE id=$2', [today, r.id]);
      try {
        const d = await collect(r.user_id);
        await require('./tg-bot').say(r.telegram_chat_id, build(r.display_name || r.username, d));
      } catch (e) {
        console.warn('mail digest', r.user_id, e.message);
        if (e.code === 'NOT_CONNECTED') await require('./tg-bot').say(r.telegram_chat_id, 'Сводка по почте не собрана: ' + e.message).catch(() => {});
      }
    }
  } catch (e) { console.error('mail digest tick:', e.message); }
  finally { _busy = false; }
}

async function getSettings(userId) {
  await ensure();
  const r = await pool.query(`SELECT to_char(digest_at,'HH24:MI') AS at, digest_weekdays FROM ticketsmodule_user_google WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
  return r.rows[0] ? { at: r.rows[0].at, weekdays: r.rows[0].digest_weekdays !== false } : null;
}
async function setSettings(userId, at, weekdays) {
  await ensure();
  if (at != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new Error('Время в формате ЧЧ:ММ');
  const r = await pool.query(`UPDATE ticketsmodule_user_google SET digest_at=$2, digest_weekdays=$3,
      digest_sent = CASE WHEN $2::time IS NOT NULL AND $2::time > (NOW() AT TIME ZONE 'UTC' + INTERVAL '5 hours')::time THEN NULL ELSE digest_sent END
    WHERE user_id=$1 AND revoked_at IS NULL`, [userId, at || null, weekdays !== false]);
  if (!r.rowCount) throw new Error('Сначала подключите почту Google');
}

module.exports = { tick, sendNow, collect, build, getSettings, setSettings };

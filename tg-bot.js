// Telegram-бот ЦУП: привязка по одноразовому коду, ответы ProLab AI (runAgent)
// правами спрашивающего, кнопки подтверждения пишущих действий, голосовые.
//
// Принципы (перенесены из AN, см. claude/pls-tg-agent в проекте):
//  • Бот не делает своих запросов к данным — только runAgent(text, user). Кто
//    спрашивает — берётся из привязки (telegram_chat_id), а не из сообщения.
//  • Агент не пишет — предлагает. Кнопки рисуются только по out.actions,
//    выполняет agent-actions.confirm под учёткой инициатора.
//  • Telegram отвечают сразу (200 в tg-routes), работают потом. Повторные
//    доставки отсекаются по update_id (ticketsmodule_tg_updates).
//  • Привязка — только по одноразовому коду из профиля; «/start <число>» не работает.
const fetch = require('node-fetch');
const crypto = require('crypto');
const { pool } = require('./auth');

const TG_TOKEN = () => process.env.TG_TOKEN || '';
const BASE_URL = () => String(process.env.PUBLIC_URL || process.env.DASH_URL || 'https://nms.prolabsupport.kz').replace(/\/+$/, '');
const LIMIT = 4000;               // Telegram отказывает целиком после 4096 знаков
const HISTORY_GAP_H = 6;          // продолжаем разговор, если пауза меньше 6 часов
const MAX_VOICE_SEC = 300, MAX_VOICE_BYTES = 20 * 1024 * 1024;

// ── Схема ────────────────────────────────────────────────────────────────────
let _ready = null;
function ensure() {
  if (_ready) return _ready;
  _ready = (async () => {
    const q = s => pool.query(s).catch(e => console.error('[tg] schema:', e.message));
    await q(`CREATE TABLE IF NOT EXISTS ticketsmodule_tg_link_codes (
      code VARCHAR(40) PRIMARY KEY, user_id INTEGER NOT NULL,
      ttl_min INTEGER NOT NULL DEFAULT 15,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), used_at TIMESTAMPTZ)`);
    await q(`CREATE TABLE IF NOT EXISTS ticketsmodule_tg_updates (
      update_id BIGINT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE TABLE IF NOT EXISTS ticketsmodule_tg_turns (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, chat_id VARCHAR(32) NOT NULL,
      thread_id INTEGER, role VARCHAR(10) NOT NULL, content TEXT NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await q(`CREATE INDEX IF NOT EXISTS idx_tg_turns_key ON ticketsmodule_tg_turns(user_id, chat_id, at DESC)`);
    await q(`ALTER TABLE ticketsmodule_users ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(32)`);
    await q(`CREATE INDEX IF NOT EXISTS idx_users_tg_chat ON ticketsmodule_users(telegram_chat_id)`);
  })();
  return _ready;
}

// ── Telegram API ─────────────────────────────────────────────────────────────
// Ошибки НЕ глотаем молча: «бот молчит» и «у бота нет права писать» иначе неразличимы.
async function tg(method, body) {
  if (!TG_TOKEN()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN()}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), timeout: 20000,
    });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !d.ok) console.error(`[tg] ${method} → ${r.status} ${d && d.description ? d.description : ''}`);
    return d;
  } catch (e) { console.error(`[tg] ${method} упал:`, e.message); return null; }
}

let _me = null;
async function me() {
  if (_me) return _me;
  const d = await tg('getMe', {});
  if (d && d.ok) _me = d.result;
  return _me || {};
}

function pieces(text) {
  const out = []; let cur = '';
  const push = p => {
    if (!cur) { cur = p; return; }
    if (cur.length + p.length + 2 <= LIMIT) { cur += '\n\n' + p; return; }
    out.push(cur); cur = p;
  };
  for (const para of String(text == null ? '' : text).split(/\n{2,}/)) {
    if (para.length <= LIMIT) { push(para); continue; }
    for (const line of para.split('\n')) {
      if (line.length <= LIMIT) { push(line); continue; }
      for (let i = 0; i < line.length; i += LIMIT) push(line.slice(i, i + LIMIT));
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
const threadOpt = thread => (thread ? { message_thread_id: thread } : {});

async function say(chat, text, thread, extra) {
  const parts = pieces(text);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim()) continue;
    last = await tg('sendMessage', {
      chat_id: String(chat), text: parts[i], disable_web_page_preview: true, ...threadOpt(thread),
      ...(i === parts.length - 1 && extra ? extra : {}),
    });
  }
  return last;
}
const typing = (chat, thread) => tg('sendChatAction', { chat_id: String(chat), action: 'typing', ...threadOpt(thread) });

// Модель иногда всё же даёт Markdown — в Telegram он мёртв. Чистим и делаем
// относительные ссылки абсолютными (отдельной строкой).
function plain(text) {
  const base = BASE_URL();
  return String(text || '')
    .replace(/\[([^\]]+)\]\((\/[^)\s]*)\)/g, (_, t, u) => `${t}: ${base}${u}`)
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1: $2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
    .replace(/`{3}[a-z]*\n?/gi, '').replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

// ── Привязка ─────────────────────────────────────────────────────────────────
// Код одноразовый; из профиля живёт 15 мин, из админки (отправить сотруднику) — сутки.
async function createLinkCode(userId, ttlMin) {
  await ensure();
  const code = crypto.randomBytes(12).toString('hex');
  await pool.query('INSERT INTO ticketsmodule_tg_link_codes (code, user_id, ttl_min) VALUES ($1,$2,$3)', [code, userId, ttlMin || 15]);
  const bot = (await me()).username || process.env.TG_BOT_NAME || '';
  return { code, url: bot ? `https://t.me/${bot}?start=${code}` : null, ttlMin: ttlMin || 15 };
}

async function linkByCode(code, msg) {
  const r = await pool.query(`
    UPDATE ticketsmodule_tg_link_codes SET used_at = NOW()
     WHERE code = $1 AND used_at IS NULL AND created_at > NOW() - make_interval(mins => ttl_min)
     RETURNING user_id`, [code]);
  if (!r.rows.length) return null;
  const uid = r.rows[0].user_id, chat = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || '';
  // Один Telegram — один сотрудник ЦУП.
  await pool.query('UPDATE ticketsmodule_users SET telegram_chat_id=NULL WHERE telegram_chat_id=$1 AND id<>$2', [chat, uid]);
  const u = (await pool.query('UPDATE ticketsmodule_users SET telegram_chat_id=$1 WHERE id=$2 AND active=true RETURNING id, username, display_name, bitrix_user_id', [chat, uid])).rows[0];
  if (!u) return null;
  // Уведомления модулей ходят по ticketsmodule_telegram_links (ключ — сотрудник Bitrix).
  if (u.bitrix_user_id) {
    await pool.query(`INSERT INTO ticketsmodule_telegram_links (bitrix_user_id, telegram_chat_id, telegram_username)
      VALUES ($1,$2,$3) ON CONFLICT (bitrix_user_id) DO UPDATE SET telegram_chat_id=$2, telegram_username=$3, linked_at=NOW()`,
      [u.bitrix_user_id, Number(chat), username]);
  }
  try { await require('./auth').auditLog(u.id, u.username, 'TELEGRAM_LINKED', null, { tg: username }, null, 'telegram'); } catch (e) {}
  return u;
}

async function unlinkUser(user) {
  await pool.query('UPDATE ticketsmodule_users SET telegram_chat_id=NULL WHERE id=$1', [user.id]);
  if (user.bitrix_user_id) await pool.query('DELETE FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [user.bitrix_user_id]);
}

async function userByTg(tgId) {
  await ensure();
  const r = await pool.query('SELECT * FROM ticketsmodule_users WHERE telegram_chat_id=$1 AND active=true LIMIT 1', [String(tgId)]);
  return r.rows[0] || null;
}

// ── Дедупликация ─────────────────────────────────────────────────────────────
async function fresh(updateId) {
  if (typeof updateId !== 'number') return true;   // проверить нечем — лучше второй ответ, чем ни одного
  const r = await pool.query('INSERT INTO ticketsmodule_tg_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id', [updateId]);
  return r.rowCount === 1;
}

// ── История разговора: продолжаем, если пауза < 6 ч; в группе ключ — чат+тема ──
async function historyOf(userId, chatId, thread) {
  const r = await pool.query(
    `SELECT role, content, at FROM ticketsmodule_tg_turns
      WHERE user_id=$1 AND chat_id=$2 AND thread_id IS NOT DISTINCT FROM $3
      ORDER BY at DESC LIMIT 16`, [userId, String(chatId), thread || null]);
  if (!r.rows.length) return [];
  if (Date.now() - new Date(r.rows[0].at).getTime() > HISTORY_GAP_H * 3600e3) return [];
  return r.rows.reverse().map(x => ({ role: x.role, content: x.content }));
}
async function saveTurn(userId, chatId, thread, role, content) {
  await pool.query('INSERT INTO ticketsmodule_tg_turns (user_id, chat_id, thread_id, role, content) VALUES ($1,$2,$3,$4,$5)',
    [userId, String(chatId), thread || null, role, String(content || '').slice(0, 8000)]).catch(e => console.error('[tg] turn:', e.message));
}

// ── Голос ────────────────────────────────────────────────────────────────────
function soundName(s, kind) {
  if (kind === 'voice') return 'voice.oga';
  if (kind === 'note') return 'note.mp4';
  const mime = String(s.mime_type || '');
  if (mime.includes('ogg')) return 'audio.ogg';
  if (mime.includes('wav')) return 'audio.wav';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'audio.m4a';
  return 'audio.mp3';
}
async function transcribeTg(msg) {
  const kind = msg.voice ? 'voice' : msg.video_note ? 'note' : 'audio';
  const s = msg.voice || msg.video_note || msg.audio;
  // Отказ — ДО скачивания.
  if ((s.duration || 0) > MAX_VOICE_SEC) return { error: 'Запись длиннее 5 минут — разбейте на части или напишите текстом.' };
  if ((s.file_size || 0) > MAX_VOICE_BYTES) return { error: 'Файл больше 20 МБ — Telegram не отдаёт такие боту.' };
  const stt = require('./stt-lib');
  if (!stt.configured()) return { error: 'Распознавание речи не настроено — напишите вопрос текстом.' };
  const f = await tg('getFile', { file_id: s.file_id });
  if (!f || !f.ok || !f.result || !f.result.file_path) return { error: 'Не удалось получить запись из Telegram.' };
  const r = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN()}/${f.result.file_path}`, { timeout: 60000 });
  if (!r.ok) return { error: 'Не удалось скачать запись.' };
  const buf = await r.buffer();
  const mime = kind === 'voice' ? 'audio/ogg' : kind === 'note' ? 'video/mp4' : (s.mime_type || 'audio/mpeg');
  const text = await stt.transcribe(buf, mime, soundName(s, kind));
  return text ? { text } : { error: 'Не разобрал запись — попробуйте ещё раз или напишите текстом.' };
}

// ── Ответ агента → текст для Telegram ────────────────────────────────────────
function tableText(t) {
  if (!t || !t.rows || !t.rows.length) return '';
  const cols = (t.columns || []).slice(0, 4);
  const lines = t.rows.slice(0, 10).map((r, i) => `${i + 1}. ` + cols.map(c => String(r[c] == null ? '' : r[c]).slice(0, 60)).filter(Boolean).join(' · '));
  const more = t.rowCount > 10 ? `\n…и ещё ${t.rowCount - 10}.` : '';
  const link = t.token ? `\n\nПолная таблица (${t.rowCount} стр.), Excel — ссылка действует 30 минут, откройте в браузере, где вы вошли в ЦУП:\n${BASE_URL()}/api/plsai/agent-export?token=${t.token}` : '';
  return `${t.title || 'Таблица'}:\n${lines.join('\n')}${more}${link}`;
}

async function offer(chat, action, thread) {
  return tg('sendMessage', {
    chat_id: String(chat), text: 'Предлагаю: ' + action.summary, ...threadOpt(thread),
    reply_markup: { inline_keyboard: [[
      { text: '✓ Подтвердить', callback_data: `ok:${action.token}` },
      { text: 'Отмена', callback_data: `no:${action.token}` },
    ]] },
  });
}

async function onButton(cb) {
  const m = String(cb.data || '').match(/^(ok|no):([0-9a-f]{24})$/i);
  // answerCallbackQuery — СРАЗУ, иначе на кнопке крутятся «часики» и жмут второй раз.
  await tg('answerCallbackQuery', { callback_query_id: cb.id, text: m && m[1] === 'ok' ? 'Выполняю…' : 'Принято' });
  if (!m || !cb.from) return;
  const msg = cb.message;
  const settle = text => msg ? tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text }) : null; // без reply_markup — кнопки снимаются
  const head = msg && msg.text ? msg.text : 'Действие';
  const user = await userByTg(cb.from.id);
  if (!user) return settle(head + '\n\nНе выполнено: я вас не узнаю.');
  const actions = require('./agent-actions');
  if (m[1].toLowerCase() === 'no') { await actions.cancel(m[2], user); return settle(head + '\n\nОтменено.'); }
  const r = await actions.confirm(m[2], user);
  if (!r.ok) return settle(head + '\n\nНе выполнено: ' + (r.error || 'ошибка'));
  return settle(head + '\n\n✓ ' + (r.already ? 'Уже было выполнено: ' : '') + (r.result || 'Готово'));
}

const HELP = 'Я ProLab AI — помощник по ЦУП. Спрашивайте текстом или голосом: «сколько закупок на оплате», «сделки Жарова на стадии договора», «поставь задачу …».\n\nПишущие действия (задачи, комментарии, события) я только предлагаю — выполняются они после вашей кнопки «Подтвердить».\n\n/digest — сводка по вашей почте Google прямо сейчас.\n/stop — отключить Telegram от ЦУП.';

// ── Главный разбор обновления ────────────────────────────────────────────────
async function handle(update) {
  await ensure();
  if (!update || !(await fresh(update.update_id))) return;
  if (update.callback_query) return onButton(update.callback_query);
  const msg = update.message;
  if (!msg || !msg.chat || !msg.from || msg.from.is_bot) return;

  const inGroup = ['group', 'supergroup'].includes(msg.chat.type);
  const chatId = String(msg.chat.id);
  const thread = inGroup && msg.chat.is_forum && msg.message_thread_id ? msg.message_thread_id : undefined;
  const bot = await me();
  let raw = String(msg.text || msg.caption || '');

  // В группе молчим, пока не позвали: упоминание бота или ответ на его сообщение.
  if (inGroup) {
    const mentioned = bot.username && new RegExp('@' + bot.username + '\\b', 'i').test(raw);
    const replied = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === bot.id;
    if (!mentioned && !replied) return;
  }
  // Упоминание — адрес, а не часть вопроса.
  let text = raw.replace(/@[A-Za-z0-9_]{3,}bot\b/gi, ' ').replace(/\s+/g, ' ').trim();

  // Команды
  const cmd = text.match(/^\/(start|stop|help|digest)(?:@\w+)?(?:\s+(\S+))?/i);
  if (cmd) {
    const c = cmd[1].toLowerCase();
    if (c === 'help') return say(chatId, HELP, thread);
    if (c === 'digest') {
      if (inGroup) return say(chatId, 'Сводку по почте присылаю только в личный чат.', thread);
      const u = await userByTg(msg.from.id);
      if (!u) return say(chatId, 'Я вас не узнаю. Откройте в ЦУП Профиль → «Подключить Telegram».');
      await typing(chatId);
      try { await require('./mail-digest').sendNow(u.id); } catch (e) { await say(chatId, 'Сводка не собрана: ' + e.message); }
      return;
    }
    if (inGroup && c !== 'help') return say(chatId, 'Подключение и отключение — только в личном чате со мной.', thread);
    if (c === 'stop') {
      const u = await userByTg(msg.from.id);
      if (!u) return say(chatId, 'Этот Telegram и так не подключён к ЦУП.');
      await unlinkUser(u);
      return say(chatId, 'Отключено: уведомления ЦУП сюда больше не придут, и я не отвечаю на вопросы с этого аккаунта. Подключить снова — Профиль в ЦУП → «Подключить Telegram».');
    }
    const arg = cmd[2] || '';
    if (arg && /^[0-9a-f]{24}$/i.test(arg)) {
      const u = await linkByCode(arg.toLowerCase(), msg);
      if (!u) return say(chatId, 'Код не подошёл: он одноразовый и живёт ограниченное время. Откройте в ЦУП Профиль → «Подключить Telegram» ещё раз.');
      return say(chatId, `Готово, ${u.display_name}. Telegram подключён к ЦУП: сюда будут приходить уведомления, и я отвечаю на вопросы — правами вашей учётки.\n\n` + HELP);
    }
    if (arg) return say(chatId, 'Эта ссылка устарела. Подключение теперь — только по личной ссылке из ЦУП: Профиль → «Подключить Telegram».');
    const u = await userByTg(msg.from.id);
    return say(chatId, u ? `Здравствуйте, ${u.display_name}. ` + HELP : 'Здравствуйте! Чтобы я вас узнал, откройте в ЦУП Профиль → «Подключить Telegram» и нажмите ссылку.');
  }

  const user = await userByTg(msg.from.id);   // в группе человек — это from.id, а не chat.id
  if (!user) return say(chatId, 'Я вас не узнаю. Откройте в ЦУП Профиль → «Подключить Telegram».', thread);

  // Голос → текст (расшифровку показываем ДО ответа)
  if (!text && (msg.voice || msg.audio || msg.video_note)) {
    await typing(chatId, thread);
    const t = await transcribeTg(msg);
    if (t.error) return say(chatId, t.error, thread);
    text = t.text;
    await say(chatId, `Расслышал: «${text}»`, thread);
  }
  if (!text) return say(chatId, 'Напишите вопрос текстом или отправьте голосовое.', thread);

  await typing(chatId, thread);
  const keep = setInterval(() => typing(chatId, thread), 4500);
  let out;
  try {
    const history = await historyOf(user.id, chatId, thread);
    out = await require('./plsai-agent').runAgent(text, user, { history, source: 'tg' });
  } catch (e) {
    out = { ok: false, error: 'Ошибка агента: ' + e.message };
  } finally { clearInterval(keep); }

  if (!out || !out.ok) return say(chatId, (out && out.error) || 'Не получилось ответить.', thread);
  const answer = plain(out.answer);
  await saveTurn(user.id, chatId, thread, 'user', text);
  await saveTurn(user.id, chatId, thread, 'assistant', answer);
  const tbl = tableText(out.table);
  await say(chatId, tbl ? `${answer}\n\n${tbl}` : answer, thread);
  for (const a of out.actions || []) await offer(chatId, a, thread);
}

// ── Режимы приёма ────────────────────────────────────────────────────────────
// С TG_WEBHOOK_SECRET — вебхук (ставим сами при старте, секрет берём из окружения,
// чтобы он не разъехался с setWebhook). Без секрета — long polling через ТОТ ЖЕ
// handle(). Вместе их держать нельзя: Telegram отвечает 409 Conflict.
async function start() {
  await ensure();
  if (!TG_TOKEN()) { console.log('[tg] TG_TOKEN не задан — бот выключен'); return; }
  const secret = process.env.TG_WEBHOOK_SECRET;
  if (secret) {
    const url = `${BASE_URL()}/tg/hook`;
    const d = await tg('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'callback_query'] });
    console.log(d && d.ok ? `✅ Telegram-бот: вебхук ${url}` : '⚠️ Telegram-бот: setWebhook не удался — см. лог выше');
  } else {
    await tg('deleteWebhook', {});
    console.log('✅ Telegram-бот: long polling (задайте TG_WEBHOOK_SECRET для вебхука)');
    poll();
  }
  // Чистка журнала обновлений и старых ходов — раз в сутки.
  setInterval(() => {
    pool.query(`DELETE FROM ticketsmodule_tg_updates WHERE at < NOW() - INTERVAL '7 days'`).catch(() => {});
    pool.query(`DELETE FROM ticketsmodule_tg_link_codes WHERE created_at < NOW() - INTERVAL '7 days'`).catch(() => {});
    pool.query(`DELETE FROM ticketsmodule_tg_turns WHERE at < NOW() - INTERVAL '30 days'`).catch(() => {});
  }, 24 * 3600e3);
}
let _offset = 0;
async function poll() {
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN()}/getUpdates?offset=${_offset + 1}&timeout=25&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`, { timeout: 35000 });
      const d = await r.json().catch(() => null);
      if (d && d.ok) {
        for (const u of d.result) {
          _offset = Math.max(_offset, u.update_id);
          handle(u).catch(e => console.error('[tg] разбор упал:', e.message));
        }
      } else {
        if (d && d.error_code === 409) console.error('[tg] 409: стоит вебхук — опрос невозможен');
        await new Promise(res => setTimeout(res, 5000));
      }
    } catch (e) { await new Promise(res => setTimeout(res, 5000)); }
  }
}

module.exports = { ensure, start, handle, createLinkCode, unlinkUser, userByTg, pieces, plain, tableText, say };

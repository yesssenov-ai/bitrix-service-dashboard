// Личная почта Google сотрудника для ProLab AI — по OAuth, ТОЛЬКО ЧТЕНИЕ.
//
// Решения (перенесены из AN):
//  • Каждый подключает СВОЙ ящик сам (экран согласия Google). Делегирование на уровне
//    домена (читать любой ящик без согласия) сознательно не используется.
//  • Один scope: gmail.readonly. Почту ни отправить, ни удалить этим ключом нельзя.
//  • refresh-токен хранится только зашифрованным (AES-256-GCM, ключ GOOGLE_TOKEN_KEY);
//    access-токен живёт в памяти процесса ~50 минут. Тела писем НЕ хранятся.
//  • access_type=offline + prompt=consent — иначе refresh-токен приходит только при
//    самом первом согласии. state подписан HMAC и живёт 10 минут.
//  • Счёт — точный (страницы id), а не resultSizeEstimate; предел — честно «больше N».
const crypto = require('crypto');
const fetch = require('node-fetch');
const { pool } = require('./auth');

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const COUNT_CAP = 2000;          // дальше это уже выгрузка ящика, а не ответ
const BODY_CAP = 12000;          // в модель — не больше; ответ почти всегда в начале письма
const BASE_URL = () => String(process.env.PUBLIC_URL || process.env.DASH_URL || 'https://nms.prolabsupport.kz').replace(/\/+$/, '');
const REDIRECT = () => `${BASE_URL()}/google/callback`;

function configured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && /^[0-9a-f]{64}$/i.test(process.env.GOOGLE_TOKEN_KEY || ''));
}
const KEY = () => Buffer.from(process.env.GOOGLE_TOKEN_KEY, 'hex');

let _ready = null;
function ensure() {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_user_google (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, email VARCHAR(200) NOT NULL,
      token_enc TEXT NOT NULL, digest_at TIME, digest_sent DATE, revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (user_id, email))`).catch(e => { _ready = null; throw e; });
  return _ready;
}

// ── Подпись state и шифрование токена ────────────────────────────────────────
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', KEY()).update(body).digest('base64url').slice(0, 32);
  return `${body}.${mac}`;
}
function readState(s) {
  const [body, mac] = String(s || '').split('.');
  if (!body || !mac) return null;
  const want = crypto.createHmac('sha256', KEY()).update(body).digest('base64url').slice(0, 32);
  const a = Buffer.from(mac), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return (Date.now() - p.at > 10 * 60 * 1000) ? null : p;
  } catch (e) { return null; }
}
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function unseal(b64) {
  try {
    const raw = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return null; }
}

// ── OAuth ────────────────────────────────────────────────────────────────────
function authUrl(user) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: REDIRECT(), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false',
    state: signState({ uid: user.id, at: Date.now(), n: crypto.randomBytes(6).toString('hex') }),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

async function tokenCall(params) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, ...params }).toString(),
    timeout: 15000,
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, d };
}

// Обмен кода → сохраняем ящик. Возвращает { email } или бросает понятную ошибку.
async function finishConnect(user, code, state) {
  await ensure();
  const st = readState(state);
  if (!st || st.uid !== user.id) throw new Error('Ссылка подключения устарела или не ваша — начните заново из профиля');
  const { ok, d } = await tokenCall({ code, redirect_uri: REDIRECT(), grant_type: 'authorization_code' });
  if (!ok || !d.access_token) throw new Error('Google не выдал доступ: ' + (d.error_description || d.error || 'ошибка'));
  if (!d.refresh_token) throw new Error('Google не выдал постоянный доступ (refresh-токен). Отзовите доступ «ЦУП» в myaccount.google.com/permissions и подключите заново');
  if (d.scope && !String(d.scope).includes(SCOPE)) throw new Error('Не выдан доступ на чтение почты — при подключении отметьте галочку Gmail');
  const prof = await gfetch(d.access_token, '/users/me/profile');
  const email = String(prof.emailAddress || '').toLowerCase();
  if (!email) throw new Error('Не удалось узнать адрес ящика');
  // Новому ящику — сводка по умолчанию в 09:00 по будням (меняется/выключается в профиле).
  await pool.query(`INSERT INTO ticketsmodule_user_google (user_id, email, token_enc, digest_at) VALUES ($1,$2,$3,'09:00')
    ON CONFLICT (user_id, email) DO UPDATE SET token_enc=$3, revoked_at=NULL`, [user.id, email, seal(d.refresh_token)]);
  _access.delete(user.id);
  return { email };
}

// ── Доступ к ящику ───────────────────────────────────────────────────────────
const _access = new Map();     // user_id → { token, exp, email }
async function mailbox(userId) {
  await ensure();
  const r = await pool.query(`SELECT id, email, token_enc FROM ticketsmodule_user_google
    WHERE user_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [userId]);
  return r.rows[0] || null;
}
async function accessToken(userId) {
  const c = _access.get(userId);
  if (c && c.exp > Date.now() + 60e3) return c;
  const mb = await mailbox(userId);
  if (!mb) { const e = new Error('Почта Google не подключена. Подключите её в ЦУП: Профиль → «Почта Google» → «Подключить».'); e.code = 'NOT_CONNECTED'; throw e; }
  const refresh = unseal(mb.token_enc);
  if (!refresh) throw new Error('Не удалось расшифровать доступ к почте (сменился GOOGLE_TOKEN_KEY?) — подключите ящик заново');
  const { ok, d } = await tokenCall({ refresh_token: refresh, grant_type: 'refresh_token' });
  if (!ok || !d.access_token) {
    if (d.error === 'invalid_grant') {
      await pool.query('UPDATE ticketsmodule_user_google SET revoked_at=NOW() WHERE id=$1', [mb.id]);
      const e = new Error('Доступ к почте отозван или истёк — подключите ящик заново в профиле ЦУП.'); e.code = 'NOT_CONNECTED'; throw e;
    }
    throw new Error('Google не обновил доступ: ' + (d.error_description || d.error || 'ошибка'));
  }
  const v = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, email: mb.email };
  _access.set(userId, v);
  return v;
}

async function gfetch(token, path, query) {
  const url = 'https://gmail.googleapis.com/gmail/v1' + path + (query ? '?' + new URLSearchParams(query).toString() : '');
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + token }, timeout: 20000 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Gmail: ' + ((d.error && d.error.message) || ('HTTP ' + r.status)));
  return d;
}

// Пул параллельных запросов (по одному на письмо, но не больше 8 одновременно).
async function pmap(list, n, fn) {
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k]).catch(e => ({ error: e.message })); }
  }));
  return out;
}

const hdr = (h, name) => { const x = (h || []).find(y => String(y.name).toLowerCase() === name); return x ? x.value : ''; };

// ── Три инструмента агента ───────────────────────────────────────────────────
// 1) Точное число писем по запросу Gmail (язык поиска Gmail: from:, to:, after:, is:unread…).
async function mailCount(user, q) {
  const { token, email } = await accessToken(user.id);
  let n = 0, pageToken = '', capped = false;
  do {
    const d = await gfetch(token, '/users/me/messages', { q: q || '', maxResults: '500', fields: 'messages/id,nextPageToken', ...(pageToken ? { pageToken } : {}) });
    n += (d.messages || []).length;
    pageToken = d.nextPageToken || '';
    if (n >= COUNT_CAP && pageToken) { capped = true; break; }
  } while (pageToken);
  return { mailbox: email, query: q || '', count: n, capped, note: capped ? `больше ${COUNT_CAP}` : null };
}

// 2) Заголовки писем (новые сверху): кто, кому, тема, дата, кусочек текста.
async function mailFind(user, q, limit) {
  const { token, email } = await accessToken(user.id);
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 20, 50));
  const d = await gfetch(token, '/users/me/messages', { q: q || '', maxResults: String(lim), fields: 'messages/id,nextPageToken,resultSizeEstimate' });
  const ids = (d.messages || []).map(m => m.id);
  // Повторяющийся metadataHeaders собираем строкой: URLSearchParams из объекта повтор не умеет.
  const metas2 = await pmap(ids, 8, async id => {
    const qs = 'format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date&fields=id,threadId,labelIds,snippet,internalDate,payload/headers';
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${qs}`, { headers: { authorization: 'Bearer ' + token }, timeout: 20000 });
    return r.ok ? r.json() : { id, error: 'HTTP ' + r.status };
  });
  const items = metas2.map((m, i) => {
    if (!m || m.error) return { id: ids[i], error: (m && m.error) || 'нет данных' };
    const h = m.payload && m.payload.headers;
    return {
      id: m.id, thread: m.threadId,
      date: m.internalDate ? new Date(Number(m.internalDate) + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : hdr(h, 'date'),
      from: hdr(h, 'from'), to: hdr(h, 'to'), cc: hdr(h, 'cc'), subject: hdr(h, 'subject'),
      unread: (m.labelIds || []).includes('UNREAD'),
      snippet: String(m.snippet || '').slice(0, 200),
    };
  });
  return { mailbox: email, query: q || '', shown: items.length, more: !!d.nextPageToken, items };
}

function decodeB64(data) { return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function toText(buf, charset) {
  const cs = String(charset || 'utf-8').toLowerCase();
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii') return buf.toString('utf8');
  try { return require('iconv-lite').decode(buf, cs); } catch (e) { return buf.toString('utf8'); }
}
function stripHtml(html) {
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}
function charsetOf(part) {
  const ct = hdr(part.headers, 'content-type');
  const m = ct.match(/charset="?([^";]+)"?/i);
  return m ? m[1] : 'utf-8';
}
function walk(part, acc) {
  if (!part) return acc;
  const mt = String(part.mimeType || '').toLowerCase();
  if (part.filename) { acc.files.push(part.filename); }
  else if (mt === 'text/plain' && part.body && part.body.data) acc.plain.push(toText(decodeB64(part.body.data), charsetOf(part)));
  else if (mt === 'text/html' && part.body && part.body.data) acc.html.push(toText(decodeB64(part.body.data), charsetOf(part)));
  (part.parts || []).forEach(p => walk(p, acc));
  return acc;
}

// 3) Одно письмо целиком (текст обрезается до 12 000 знаков).
async function mailRead(user, id) {
  if (!/^[0-9a-f]{6,32}$/i.test(String(id || ''))) throw new Error('Некорректный id письма — возьмите id из mail_find');
  const { token, email } = await accessToken(user.id);
  const m = await gfetch(token, '/users/me/messages/' + id, { format: 'full' });
  const h = m.payload && m.payload.headers;
  const acc = walk(m.payload, { plain: [], html: [], files: [] });
  let body = acc.plain.join('\n\n').trim() || stripHtml(acc.html.join('\n\n'));
  const cut = body.length > BODY_CAP;
  if (cut) body = body.slice(0, BODY_CAP);
  return {
    mailbox: email, id: m.id, thread: m.threadId,
    date: m.internalDate ? new Date(Number(m.internalDate) + 5 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : hdr(h, 'date'),
    from: hdr(h, 'from'), to: hdr(h, 'to'), cc: hdr(h, 'cc'), subject: hdr(h, 'subject'),
    attachments: acc.files, body, truncated: cut,
  };
}

async function status(userId) {
  await ensure();
  const r = await pool.query(`SELECT email, created_at, revoked_at FROM ticketsmodule_user_google WHERE user_id=$1 ORDER BY created_at DESC`, [userId]);
  const live = r.rows.find(x => !x.revoked_at);
  return { configured: configured(), connected: !!live, email: live ? live.email : null, since: live ? live.created_at : null, revoked: !live && r.rows.length > 0 };
}

async function disconnect(userId) {
  await ensure();
  const r = await pool.query('SELECT id, token_enc FROM ticketsmodule_user_google WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
  for (const row of r.rows) {
    const t = unseal(row.token_enc);
    if (t) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t), timeout: 10000 }).catch(() => {});
  }
  await pool.query('DELETE FROM ticketsmodule_user_google WHERE user_id=$1', [userId]);
  _access.delete(userId);
}

// Сырые помощники для сводки: id писем по запросу (с пределом) и заголовки пачкой.
async function listIds(token, q, cap) {
  const ids = []; let pageToken = '';
  do {
    const d = await gfetch(token, '/users/me/messages', { q: q || '', maxResults: '500', fields: 'messages(id,threadId),nextPageToken', ...(pageToken ? { pageToken } : {}) });
    for (const m of d.messages || []) ids.push(m);
    pageToken = d.nextPageToken || '';
  } while (pageToken && ids.length < cap);
  return { ids: ids.slice(0, cap), capped: !!pageToken || ids.length > cap };
}
async function headersOf(token, ids, names) {
  const qs = 'format=metadata&' + names.map(n => 'metadataHeaders=' + n).join('&') + '&fields=id,threadId,labelIds,internalDate,payload/headers';
  return pmap(ids, 8, async id => {
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?${qs}`, { headers: { authorization: 'Bearer ' + token }, timeout: 20000 });
    if (!r.ok) return { id, error: 'HTTP ' + r.status };
    const m = await r.json();
    const h = (m.payload && m.payload.headers) || [];
    const o = { id: m.id, thread: m.threadId, labels: m.labelIds || [], at: Number(m.internalDate) || 0 };
    for (const n of names) o[n.toLowerCase()] = hdr(h, n.toLowerCase());
    return o;
  });
}
async function threadMeta(token, threadId) {
  return gfetch(token, '/users/me/threads/' + threadId, { format: 'metadata', metadataHeaders: 'From', fields: 'id,messages(id,labelIds,internalDate,payload/headers)' });
}

module.exports = { REDIRECT, tokenCall, accessToken, listIds, headersOf, threadMeta, configured, ensure, authUrl, finishConnect, status, disconnect, mailCount, mailFind, mailRead, signState, readState, seal, unseal, stripHtml, walk };

// Google Диск ЦУП — общий диск компании, к которому ЦУП ходит от имени ОДНОЙ
// технической учётки (admin@), подключённой суперадмином через «Войти через Google».
//
// Решения:
//  • Тот же OAuth-клиент и тот же адрес возврата, что у почты (/google/callback):
//    никаких сервисных аккаунтов, IAM, JSON-ключей и делегирования на домен.
//  • ЦУП работает ТОЛЬКО внутри выбранного общего диска (driveId): каждый запрос
//    ограничен corpora=drive&driveId, при чтении файла проверяется его driveId —
//    личный «Мой диск» учётки и другие общие диски ЦУПу недоступны.
//  • refresh-токен — AES-256-GCM тем же GOOGLE_TOKEN_KEY (seal/unseal из gmail-lib),
//    в таблице ticketsmodule_google_drive (закрыта для агента по шаблону имени).
//  • Папки «Закупки» видят в агенте только те, кому доступен модуль закупок.
const crypto = require('crypto');
const fetch = require('node-fetch');
const { pool } = require('./auth');

const SCOPE = 'https://www.googleapis.com/auth/drive';
const API = 'https://www.googleapis.com/drive/v3';
const TEXT_CAP = 12000;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const FOLDER = 'application/vnd.google-apps.folder';
const RESTRICTED_TOP = { 'Закупки': 'ticketsmodule_procurement' };   // папка → таблица-«пропуск» в ctx.allowed

const gm = () => require('./gmail-lib');
const configured = () => gm().configured();

let _ready = null;
function ensure() {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_google_drive (
      id INTEGER PRIMARY KEY, email VARCHAR(200), token_enc TEXT,
      drive_id VARCHAR(100), drive_name VARCHAR(200),
      connected_by INTEGER, connected_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ)`).catch(e => { _ready = null; throw e; });
  return _ready;
}

// ── OAuth (через общий /google/callback; state.p='drive') ─────────────────────
function authUrl(user) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: gm().REDIRECT(), response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent select_account',
    state: gm().signState({ uid: user.id, p: 'drive', at: Date.now(), n: crypto.randomBytes(6).toString('hex') }),
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString();
}

async function finishConnect(user, code, st) {
  await ensure();
  const { ok, d } = await gm().tokenCall({ code, redirect_uri: gm().REDIRECT(), grant_type: 'authorization_code' });
  if (!ok || !d.access_token) throw new Error('Google не выдал доступ: ' + (d.error_description || d.error || 'ошибка'));
  if (!d.refresh_token) throw new Error('Google не выдал постоянный доступ — отзовите доступ «ЦУП» в myaccount.google.com/permissions у этой учётки и подключите заново');
  if (d.scope && !String(d.scope).includes(SCOPE)) throw new Error('Не выдан доступ к Google Диску — при подключении разрешите доступ к Диску');
  const about = await gget(d.access_token, '/about', { fields: 'user(emailAddress)' });
  const email = String((about.user && about.user.emailAddress) || '').toLowerCase();
  await pool.query(`INSERT INTO ticketsmodule_google_drive (id, email, token_enc, connected_by, connected_at, revoked_at)
    VALUES (1,$1,$2,$3,NOW(),NULL)
    ON CONFLICT (id) DO UPDATE SET email=$1, token_enc=$2, connected_by=$3, connected_at=NOW(), revoked_at=NULL`,
    [email, gm().seal(d.refresh_token), user.id]);
  _tok = null; _folders.clear(); _tops.clear();
  return { email };
}

let _tok = null;
async function row() { await ensure(); return (await pool.query('SELECT * FROM ticketsmodule_google_drive WHERE id=1')).rows[0] || null; }
async function token() {
  if (_tok && _tok.exp > Date.now() + 60e3) return _tok;
  const r = await row();
  if (!r || !r.token_enc || r.revoked_at) { const e = new Error('Google Диск ЦУП не подключён (Админка → «Google Диск ЦУП»)'); e.code = 'NOT_CONNECTED'; throw e; }
  const refresh = gm().unseal(r.token_enc);
  if (!refresh) throw new Error('Не удалось расшифровать доступ к Диску — подключите заново');
  const { ok, d } = await gm().tokenCall({ refresh_token: refresh, grant_type: 'refresh_token' });
  if (!ok || !d.access_token) {
    if (d.error === 'invalid_grant') { await pool.query('UPDATE ticketsmodule_google_drive SET revoked_at=NOW() WHERE id=1'); const e = new Error('Доступ к Google Диску отозван — подключите заново'); e.code = 'NOT_CONNECTED'; throw e; }
    throw new Error('Google не обновил доступ к Диску: ' + (d.error_description || d.error || 'ошибка'));
  }
  _tok = { t: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000, driveId: r.drive_id, email: r.email };
  return _tok;
}
async function driveCtx() {
  const tk = await token();
  if (!tk.driveId) { const e = new Error('Не выбран общий диск для ЦУП (Админка → «Google Диск ЦУП»)'); e.code = 'NOT_CONNECTED'; throw e; }
  return tk;
}

async function gget(t, path, query) {
  const r = await fetch(API + path + (query ? '?' + new URLSearchParams(query) : ''), { headers: { authorization: 'Bearer ' + t }, timeout: 30000 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Диск: ' + ((d.error && d.error.message) || 'HTTP ' + r.status));
  return d;
}
const ALL = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };
const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// ── Настройка: какие общие диски видит учётка, выбрать один ────────────────────
async function listSharedDrives() {
  const { t } = await token();
  const d = await gget(t, '/drives', { pageSize: '100', fields: 'drives(id,name)' });
  return d.drives || [];
}
async function selectDrive(driveId) {
  const drives = await listSharedDrives();
  const dr = drives.find(x => x.id === driveId);
  if (!dr) throw new Error('Учётка не состоит в этом общем диске — добавьте её участником («Менеджер контента»)');
  await pool.query('UPDATE ticketsmodule_google_drive SET drive_id=$1, drive_name=$2 WHERE id=1', [dr.id, dr.name]);
  _tok = null; _folders.clear(); _tops.clear();
  return dr;
}
async function status() {
  const r = await row();
  return { configured: configured(), connected: !!(r && r.token_enc && !r.revoked_at), email: r && r.email, driveId: r && r.drive_id, driveName: r && r.drive_name, since: r && r.connected_at };
}
async function disconnect() {
  const r = await row();
  if (r && r.token_enc) {
    const t = gm().unseal(r.token_enc);
    if (t) await fetch('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'token=' + encodeURIComponent(t), timeout: 10000 }).catch(() => {});
  }
  await pool.query('DELETE FROM ticketsmodule_google_drive WHERE id=1');
  _tok = null; _folders.clear(); _tops.clear();
}

// ── Папки и загрузка ─────────────────────────────────────────────────────────
const _folders = new Map();   // "driveId|путь" → id
const clean = s => String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Без названия';
async function ensureFolder(parts) {
  const { t, driveId } = await driveCtx();
  let parent = driveId, key = driveId;
  for (const raw of parts) {
    const name = clean(raw);
    key += '|' + name;
    if (_folders.has(key)) { parent = _folders.get(key); continue; }
    const q = `name='${esc(name)}' and '${parent}' in parents and mimeType='${FOLDER}' and trashed=false`;
    const found = await gget(t, '/files', { q, corpora: 'drive', driveId, ...ALL, fields: 'files(id)', pageSize: '1' });
    let id = found.files && found.files[0] && found.files[0].id;
    if (!id) {
      const r = await fetch(API + '/files?supportsAllDrives=true&fields=id', {
        method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }), timeout: 30000,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('Google Диск (папка): ' + ((d.error && d.error.message) || 'HTTP ' + r.status));
      id = d.id;
    }
    _folders.set(key, id); parent = id;
  }
  return parent;
}

async function upload(parts, filename, mime, buffer) {
  const { t } = await driveCtx();
  const parent = await ensureFolder(parts);
  const boundary = 'cup' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name: clean(filename).slice(0, 200), parents: [parent] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`),
    buffer, Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': `multipart/related; boundary=${boundary}`, 'content-length': body.length },
    body, timeout: 120000,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Диск (загрузка): ' + ((d.error && d.error.message) || 'HTTP ' + r.status));
  return { id: d.id, link: d.webViewLink };
}

// Копия файла закупки: Закупки / <год> / <название #id> / <документ>. Тихо пропускает,
// если Диск не подключён; ошибка не мешает основной загрузке (её делает вызывающий).
async function mirrorProcurementFile(fileRowId) {
  try {
    if (!configured()) return null;
    const st = await status(); if (!st.connected || !st.driveId) return null;
    const f = (await pool.query(`SELECT f.id, f.request_id, f.slot, f.filename, f.mime, f.content_b64, f.drive_file_id, r.title, r.bitrix_item_id, r.created_at
        FROM ticketsmodule_procurement_files f LEFT JOIN ticketsmodule_procurement r ON r.id=f.request_id WHERE f.id=$1`, [fileRowId])).rows[0];
    if (!f || f.drive_file_id || !f.content_b64) return null;
    const labels = require('./procurement-calc').SLOT_LABELS || {};
    const year = String(new Date(f.created_at || Date.now()).getFullYear());
    const folder = `${f.title || 'Закупка'} #${f.bitrix_item_id || f.request_id}`;
    const up = await upload(['Закупки', year, folder, labels[f.slot] || f.slot], f.filename || 'file', f.mime, Buffer.from(f.content_b64, 'base64'));
    await pool.query('UPDATE ticketsmodule_procurement_files SET drive_file_id=$1 WHERE id=$2', [up.id, f.id]);
    return up;
  } catch (e) { console.warn('drive mirror (закупка):', e.message); return null; }
}
async function mirrorShipFile(shipFileId) {
  try {
    if (!configured()) return null;
    const st = await status(); if (!st.connected || !st.driveId) return null;
    const f = (await pool.query('SELECT id, deal_id, filename, mime, content_b64, drive_file_id, uploaded_at AS created_at FROM ticketsmodule_procurement_ship_files WHERE id=$1', [shipFileId])).rows[0];
    if (!f || f.drive_file_id || !f.content_b64) return null;
    const year = String(new Date(f.created_at || Date.now()).getFullYear());
    const up = await upload(['Закупки', year, 'Отгрузки', `Сделка ${f.deal_id}`], f.filename || 'file', f.mime, Buffer.from(f.content_b64, 'base64'));
    await pool.query('UPDATE ticketsmodule_procurement_ship_files SET drive_file_id=$1 WHERE id=$2', [up.id, f.id]);
    return up;
  } catch (e) { console.warn('drive mirror (отгрузка):', e.message); return null; }
}

// ── Поиск и чтение для ProLab AI ─────────────────────────────────────────────
const _tops = new Map();      // folderId → имя папки верхнего уровня ('' — корень диска)
async function topFolderOf(t, driveId, parents) {
  let id = parents && parents[0];
  const chain = [];
  for (let i = 0; i < 12 && id && id !== driveId; i++) {
    if (_tops.has(id)) { const v = _tops.get(id); chain.forEach(c => _tops.set(c, v)); return v; }
    chain.push(id);
    const f = await gget(t, '/files/' + id, { ...ALL, fields: 'id,name,parents' });
    if (!f.parents || !f.parents[0] || f.parents[0] === driveId) { chain.forEach(c => _tops.set(c, f.name)); return f.name; }
    id = f.parents[0];
  }
  return '';
}
function mayRead(top, ctx) {
  const need = RESTRICTED_TOP[top];
  if (!need) return true;
  if (ctx && ctx.group) return false;                       // закрытые папки — не в групповых чатах
  return !!(ctx && ctx.allowed && ctx.allowed.has(need));
}

async function search(text, limit, ctx) {
  const { t, driveId } = await driveCtx();
  const words = String(text || '').trim();
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 15, 30));
  let q = 'trashed=false and mimeType != \'' + FOLDER + '\'';
  if (words) q += ` and (name contains '${esc(words)}' or fullText contains '${esc(words)}')`;
  const d = await gget(t, '/files', { q, corpora: 'drive', driveId, ...ALL, pageSize: String(Math.min(lim * 3, 100)), orderBy: words ? '' : 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,size,parents,webViewLink)' });
  const out = [];
  let hidden = 0;
  for (const f of d.files || []) {
    const top = await topFolderOf(t, driveId, f.parents);
    if (!mayRead(top, ctx)) { hidden++; continue; }
    out.push({ id: f.id, name: f.name, folder: top || '(корень)', type: f.mimeType, modified: f.modifiedTime ? f.modifiedTime.slice(0, 10) : '', size: f.size ? Number(f.size) : null, link: f.webViewLink });
    if (out.length >= lim) break;
  }
  return { drive: (await status()).driveName, query: words, shown: out.length, hiddenNoAccess: hidden, files: out };
}

async function readText(fileId, ctx) {
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(String(fileId || ''))) throw new Error('Некорректный id файла — возьмите его из drive_search');
  const { t, driveId } = await driveCtx();
  const f = await gget(t, '/files/' + fileId, { ...ALL, fields: 'id,name,mimeType,size,driveId,parents,webViewLink,modifiedTime' });
  if (f.driveId !== driveId) throw new Error('Файл не на общем диске ЦУП — читать его нельзя');
  const top = await topFolderOf(t, driveId, f.parents);
  if (!mayRead(top, ctx)) throw new Error(`Нет доступа к папке «${top}» для вашей роли`);
  const mt = f.mimeType || '';
  let text = '';
  const dl = async (url) => {
    const r = await fetch(url, { headers: { authorization: 'Bearer ' + t }, timeout: 60000 });
    if (!r.ok) throw new Error('Google Диск (скачивание): HTTP ' + r.status);
    return r.buffer();
  };
  if (mt.startsWith('application/vnd.google-apps.')) {
    const exp = mt.endsWith('.spreadsheet') ? 'text/csv' : mt.endsWith('.document') || mt.endsWith('.presentation') ? 'text/plain' : null;
    if (!exp) throw new Error('Этот тип Google-файла не читается как текст');
    text = (await dl(`${API}/files/${fileId}/export?mimeType=${encodeURIComponent(exp)}`)).toString('utf8');
  } else {
    if (f.size && Number(f.size) > MAX_READ_BYTES) throw new Error('Файл больше 20 МБ — откройте его по ссылке');
    const buf = await dl(`${API}/files/${fileId}?alt=media&supportsAllDrives=true`);
    const name = String(f.name || '').toLowerCase();
    if (mt === 'application/pdf' || name.endsWith('.pdf')) text = (await require('pdf-parse')(buf)).text || '';
    else if (name.endsWith('.docx') || mt.includes('wordprocessingml')) text = (await require('mammoth').extractRawText({ buffer: buf })).value || '';
    else if (/\.(xlsx|xls|csv)$/.test(name) || mt.includes('spreadsheet') || mt.includes('excel')) {
      const X = require('xlsx'); const wb = X.read(buf, { type: 'buffer' });
      text = wb.SheetNames.slice(0, 5).map(n => `# ${n}\n` + X.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
    } else if (mt.startsWith('text/') || /\.(txt|md|json|xml|html?)$/.test(name)) text = buf.toString('utf8');
    else throw new Error('Не умею читать этот формат (' + (mt || name) + ') — откройте по ссылке');
  }
  text = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const cut = text.length > TEXT_CAP;
  return { id: f.id, name: f.name, folder: top || '(корень)', modified: (f.modifiedTime || '').slice(0, 10), link: f.webViewLink, text: cut ? text.slice(0, TEXT_CAP) : text, truncated: cut };
}

module.exports = { SCOPE, configured, ensure, authUrl, finishConnect, status, disconnect, listSharedDrives, selectDrive, ensureFolder, upload, mirrorProcurementFile, mirrorShipFile, search, readText, mayRead };

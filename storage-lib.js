// Объектное хранилище файлов (Supabase Storage) через REST — БЕЗ SDK.
// Байты файла живут в бакете Storage (100 ГБ на Pro), в Postgres — только
// карточка (storage-lib не трогает БД). Конфиг из env:
//   SUPABASE_URL                — https://<ref>.supabase.co (если нет — выводим из DATABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY   — сервисный ключ (ТОЛЬКО на сервере!)
//   TC_BUCKET                   — имя бакета (по умолчанию 'tc-files')
const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');

const BUCKET = process.env.TC_BUCKET || 'tc-files';

// Адрес проекта Supabase: из SUPABASE_URL, иначе пытаемся вывести из DATABASE_URL
// (postgres.<ref>:... у пулера или db.<ref>.supabase.co у прямого подключения).
function baseUrl() {
  let url = process.env.SUPABASE_URL || '';
  if (!url) {
    const db = process.env.DATABASE_URL || '';
    const m = /postgres(?:ql)?:\/\/postgres\.([a-z0-9]+):/i.exec(db)
          || /@db\.([a-z0-9]+)\.supabase\.co/i.exec(db);
    if (m && m[1]) url = `https://${m[1]}.supabase.co`;
  }
  return url.replace(/\/+$/, '');
}
function key() { return process.env.SUPABASE_SERVICE_ROLE_KEY || ''; }
function configured() { return !!(baseUrl() && key()); }
function headers(extra) {
  const k = key();
  return Object.assign({ Authorization: `Bearer ${k}`, apikey: k }, extra || {});
}
function notConfigured() {
  const e = new Error('Хранилище файлов не настроено: задайте SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
  e.code = 'STORAGE_NOT_CONFIGURED';
  return e;
}

// Создать приватный бакет, если его ещё нет (идемпотентно).
let _bucketReady = null;
async function ensureBucket() {
  if (!configured()) throw notConfigured();
  if (_bucketReady) return _bucketReady;
  _bucketReady = (async () => {
    try {
      const r = await fetchFn(`${baseUrl()}/storage/v1/bucket`, {
        method: 'POST',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: false, file_size_limit: 52428800 }),
      });
      if (!r.ok && r.status !== 409) {
        const t = await r.text();
        if (!/already exists|duplicate/i.test(t)) console.warn('ensureBucket:', r.status, t.slice(0, 160));
      }
    } catch (e) { console.warn('ensureBucket error:', e.message); _bucketReady = null; }
  })();
  return _bucketReady;
}

// Загрузить буфер в объект по ключу. Возвращает { ok }.
async function upload(objectKey, buffer, mime) {
  if (!configured()) throw notConfigured();
  await ensureBucket();
  const r = await fetchFn(`${baseUrl()}/storage/v1/object/${BUCKET}/${encodeURI(objectKey)}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': mime || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buffer,
  });
  if (!r.ok) throw new Error('Storage upload ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return { ok: true };
}

// Короткоживущая подписанная ссылка на скачивание (по умолчанию 5 минут).
async function signedUrl(objectKey, expiresIn = 300) {
  if (!configured()) throw notConfigured();
  const r = await fetchFn(`${baseUrl()}/storage/v1/object/sign/${BUCKET}/${encodeURI(objectKey)}`, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn }),
  });
  if (!r.ok) throw new Error('Storage sign ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  // signedURL приходит как относительный путь вида /object/sign/<bucket>/<key>?token=...
  return baseUrl() + '/storage/v1' + j.signedURL;
}

// Удалить объект (best-effort).
async function remove(objectKey) {
  if (!configured()) return { ok: false };
  try {
    const r = await fetchFn(`${baseUrl()}/storage/v1/object/${BUCKET}/${encodeURI(objectKey)}`, {
      method: 'DELETE', headers: headers(),
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { BUCKET, configured, ensureBucket, upload, signedUrl, remove };

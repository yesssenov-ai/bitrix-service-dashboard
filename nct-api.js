// Клиент API Национального каталога (НКТ).
//  - Публичный поиск (без ключа): проверка, есть ли товар/NTIN в каталоге.
//  - Portal API по ключу X-API-KEY (env NCT_API_KEY): справочники, атрибуты, заявки.
// База подтверждена разведкой: https://nationalcatalog.kz/gwp/portal/api/v1
const PORTAL = 'https://nationalcatalog.kz/gwp/portal/api/v1';
const SEARCH_URL = 'https://nationalcatalog.kz/gw/search/api/v1/search';

function apiKey() { return process.env.NCT_API_KEY || ''; }

async function call(method, url, { body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth) headers['X-API-KEY'] = apiKey();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal });
  } finally { clearTimeout(t); }
  const text = await res.text().catch(() => '');
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const msg = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    const e = new Error(`НКТ: ${msg}`); e.status = res.status; e.body = json || text; throw e;
  }
  return json;
}
const P = (m, path, body) => call(m, PORTAL + path, { body });

// ── Публичный поиск (без ключа) ────────────────────────────────────────────────
async function searchCatalog(query, page = 0, size = 10) {
  return call('POST', SEARCH_URL, { auth: false, body: { query: String(query || '').slice(0, 300), page, size } });
}

// ── Справочники ────────────────────────────────────────────────────────────────
const listDictionaries = () => P('GET', '/dictionaries');
const dictRoots = (code) => P('GET', `/dictionaries/${encodeURIComponent(code)}/roots`);
const dictChildren = (code, parentId) => P('GET', `/dictionaries/${encodeURIComponent(code)}/children/${parentId}`);
const dictItems = (code, page = 1, size = 50) => P('GET', `/dictionaries/${encodeURIComponent(code)}/items?page=${page}&size=${size}`);

// ── Атрибуты заявки ────────────────────────────────────────────────────────────
const getAttributes = () => P('GET', '/products/requests/attributes');

// ── Заявки на товар ────────────────────────────────────────────────────────────
const listRequests = (page = 1, size = 20, status) => P('GET', `/products/requests?page=${page}&size=${size}` + (status ? `&status=${encodeURIComponent(status)}` : ''));
const getRequestDetails = (id) => P('GET', `/products/requests/${id}/details`);
const getRequestStatus = (id) => P('GET', `/products/requests/${id}/status`);
const createRequest = ({ oktru, autoPublication = false, attributes }) => P('POST', '/products/requests', { oktru, autoPublication: !!autoPublication, attributes: attributes || [] });
const updateRequest = (id, { oktru, autoPublication = false, attributes }) => P('PUT', `/products/requests/${id}`, { oktru, autoPublication: !!autoPublication, attributes: attributes || [] });
const sendModeration = (id) => P('PUT', `/products/requests/${id}/moderation`);
const publishRequest = (id) => P('PUT', `/products/requests/${id}/publish`);
const cancelRequest = (id) => P('PUT', `/products/requests/${id}/cancel`);
const deleteRequest = (id) => P('DELETE', `/products/requests/${id}`);

async function health() {
  const out = { keyPresent: !!apiKey() };
  try { const d = await listDictionaries(); out.ok = true; out.dictionaries = Array.isArray(d) ? d.length : null; }
  catch (e) { out.ok = false; out.status = e.status || 0; out.error = e.message; }
  return out;
}

module.exports = {
  searchCatalog, listDictionaries, dictRoots, dictChildren, dictItems, getAttributes,
  listRequests, getRequestDetails, getRequestStatus, createRequest, updateRequest,
  sendModeration, publishRequest, cancelRequest, deleteRequest, health,
};

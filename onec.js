// Адаптер HTTP-сервисов 1С. Все обращения к 1С — только через onec().
// Со стороны 1С публикуются HTTP-сервисы, отдающие JSON. Авторизация — Basic.
// Настройки в окружении Railway:
//   ONEC_BASE_URL  — базовый адрес, напр. http://100.80.0.10:80/BUH/hs/prolab
//   ONEC_USER      — логин служебного пользователя 1С
//   ONEC_PASS      — пароль
//   ONEC_PROXY_URL — (опц.) HTTP-прокси, через который ходить к 1С. Нужен для схемы
//                    Tailscale: контейнер tailscale поднимает HTTP-прокси в приватной
//                    сети Railway, напр. http://${{tailscale.RAILWAY_PRIVATE_DOMAIN}}:1055
//   ONEC_INSECURE_TLS — (опц.) 1 — ослабить проверку TLS ТОЛЬКО для запросов к 1С
//                    (самоподписанный серт при прямой https-публикации). Для http
//                    внутри Tailscale не нужен.
// Пока ONEC_BASE_URL не задан — модули работают на мок-данных (isConfigured()=false).
const fetch = require('node-fetch');
const https = require('https');

const BASE = process.env.ONEC_BASE_URL || '';
const USER = process.env.ONEC_USER || '';
const PASS = process.env.ONEC_PASS || '';
const PROXY = process.env.ONEC_PROXY_URL || '';
// Внутренняя публикация 1С часто с самоподписанным сертификатом (в инструкции 1С
// просят отключить проверку SSL). Включаем ослабленную проверку ТОЛЬКО для запросов
// к 1С (через env ONEC_INSECURE_TLS=1) — глобальный TLS и прокси не трогаем.
const INSECURE = /^(1|true|yes)$/i.test(process.env.ONEC_INSECURE_TLS || '');
const insecureAgent = INSECURE ? new https.Agent({ rejectUnauthorized: false }) : null;

// Прокси-агенты (для схемы Tailscale). Создаём лениво и переиспользуем (keep-alive).
let _httpProxyAgent = null, _httpsProxyAgent = null;
function agentFor(url) {
  const isHttps = /^https:/i.test(url);
  if (PROXY) {
    if (isHttps) {
      if (!_httpsProxyAgent) {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        _httpsProxyAgent = new HttpsProxyAgent(PROXY, { rejectUnauthorized: !INSECURE });
      }
      return _httpsProxyAgent;
    }
    if (!_httpProxyAgent) {
      const { HttpProxyAgent } = require('http-proxy-agent');
      _httpProxyAgent = new HttpProxyAgent(PROXY);
    }
    return _httpProxyAgent;
  }
  return (isHttps && insecureAgent) ? insecureAgent : undefined;
}

function isConfigured() { return !!BASE; }

// Платформа 1С отдаёт ошибки как XML-страницу vrscore (exception.xslt), где
// человекочитаемый текст лежит в <descr>. Достаём его, иначе — очищенный фрагмент.
// Без этого в UI попадал только XML-заголовок (namespace'ы), а не сама причина.
function onecErrText(txt) {
  const s = String(txt || '');
  const m = s.match(/<descr[^>]*>([\s\S]*?)<\/descr>/i) || s.match(/\bdescr\s*=\s*"([^"]+)"/i);
  if (m && m[1].trim()) return '1С: ' + m[1].replace(/\s+/g, ' ').trim().slice(0, 600);
  return s.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
}

// ── Управление сеансами 1С ───────────────────────────────────────────────────
// Если в публикации HTTP-сервиса включено «повторное использование сеансов»,
// платформа требует управлять сеансом: первый запрос стартует сеанс заголовком
// `IBSession: start`, а дальше клиент шлёт полученную куку сеанса. Наш клиент был
// stateless (только Basic) — при включённом reuse это даёт 400 «Не указан заголовок
// управления сеансами…». Стратегия без регресса для режима «не использовать»:
// сначала пробуем как раньше (без сеанса); только при ошибке сеанса стартуем сеанс
// и переиспользуем куку. Кука живёт в памяти процесса.
let _sessionCookie = '';

function captureCookie(res) {
  let raw = [];
  try { raw = (res.headers.raw && res.headers.raw()['set-cookie']) || []; }
  catch (e) { const h = res.headers.get && res.headers.get('set-cookie'); if (h) raw = [h]; }
  const pairs = raw.map(c => String(c).split(';')[0].trim()).filter(Boolean);
  if (pairs.length) _sessionCookie = pairs.join('; ');
}
function isSessionErr(status, txt) {
  return status === 400 && /сеанс|сеансами|session|куки|cookie|идентификатор/i.test(String(txt || ''));
}

async function onec(service, params = {}, opts = {}) {
  if (!BASE) throw new Error('1С не настроена (нет ONEC_BASE_URL)');
  try { return await onecOnce(service, params, opts, false); }
  catch (e) {
    // Сеанс протух / публикация требует управления сеансами — стартуем сеанс и повторяем один раз.
    if (e && e.__session) { _sessionCookie = ''; return await onecOnce(service, params, opts, true); }
    throw e;
  }
}

async function onecOnce(service, params, opts, startSession) {
  const method = (opts.method || 'GET').toUpperCase();
  const timeoutMs = opts.timeoutMs || 30000;
  const headers = { 'Accept': 'application/json' };
  if (USER || PASS) headers['Authorization'] = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
  if (startSession) headers['IBSession'] = 'start';     // явный старт сеанса (режим reuse)
  else if (_sessionCookie) headers['Cookie'] = _sessionCookie;  // переиспользуем сеанс

  let url = BASE.replace(/\/$/, '') + '/' + String(service).replace(/^\//, '');
  let body;
  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += '?' + qs;
  } else {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(params);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal, agent: agentFor(url) });
    clearTimeout(t);
    captureCookie(res);
    const txt = await res.text();
    if (!res.ok) {
      const err = new Error('1С HTTP ' + res.status + (txt ? ': ' + onecErrText(txt) : ''));
      if (!startSession && isSessionErr(res.status, txt)) err.__session = true;
      throw err;
    }
    try { return JSON.parse(txt); }
    catch (e) { throw new Error('1С вернула не JSON: ' + onecErrText(txt)); }
  } catch (e) { clearTimeout(t); throw e; }
}

module.exports = { onec, isConfigured };

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

async function onec(service, params = {}, opts = {}) {
  if (!BASE) throw new Error('1С не настроена (нет ONEC_BASE_URL)');
  const method = (opts.method || 'GET').toUpperCase();
  const timeoutMs = opts.timeoutMs || 30000;
  const headers = { 'Accept': 'application/json' };
  if (USER || PASS) headers['Authorization'] = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');

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
    const txt = await res.text();
    if (!res.ok) throw new Error('1С HTTP ' + res.status + (txt ? ': ' + txt.slice(0, 300) : ''));
    try { return JSON.parse(txt); }
    catch (e) { throw new Error('1С вернула не JSON: ' + txt.slice(0, 200)); }
  } catch (e) { clearTimeout(t); throw e; }
}

module.exports = { onec, isConfigured };

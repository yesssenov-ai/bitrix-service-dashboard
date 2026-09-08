// Адаптер HTTP-сервисов 1С. Все обращения к 1С — только через onec().
// Со стороны 1С публикуются HTTP-сервисы, отдающие JSON. Авторизация — Basic по
// HTTPS служебным пользователем «только чтение». Настройки в окружении Railway:
//   ONEC_BASE_URL  — базовый адрес, напр. https://1c.prolabsupport.kz/pls/hs
//   ONEC_USER      — логин служебного пользователя 1С
//   ONEC_PASS      — пароль
// Пока ONEC_BASE_URL не задан — модули работают на мок-данных (isConfigured()=false).
const fetch = require('node-fetch');

const BASE = process.env.ONEC_BASE_URL || '';
const USER = process.env.ONEC_USER || '';
const PASS = process.env.ONEC_PASS || '';

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
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    clearTimeout(t);
    const txt = await res.text();
    if (!res.ok) throw new Error('1С HTTP ' + res.status + (txt ? ': ' + txt.slice(0, 300) : ''));
    try { return JSON.parse(txt); }
    catch (e) { throw new Error('1С вернула не JSON: ' + txt.slice(0, 200)); }
  } catch (e) { clearTimeout(t); throw e; }
}

module.exports = { onec, isConfigured };

const express = require('express');
const https = require('https');
const http = require('http');
const router = express.Router();
const { requireAuth } = require('../auth');

// Просмотр — любому авторизованному, кому выдан модуль (страница гейтится грантом
// requireModule('LOG')). Логистика — дашборд только для чтения.
const VIEW_ROLES = [];

// Скачиваем содержимое по URL, проходя редиректы (Bitrix отдаёт 302 на файл).
function pipeDownload(url, res, depth = 0) {
  if (depth > 5) { if (!res.headersSent) res.status(502).end('too many redirects'); return; }
  const lib = url.startsWith('https') ? https : http;
  const rq = lib.get(url, up => {
    if ([301, 302, 303, 307, 308].includes(up.statusCode) && up.headers.location) {
      up.resume();
      let loc = up.headers.location;
      if (loc.startsWith('/')) { try { loc = new URL(url).origin + loc; } catch (e) {} }
      return pipeDownload(loc, res, depth + 1);
    }
    const ct = up.headers['content-type'] || '';
    // Bitrix при протухшей/отсутствующей авторизации отдаёт 200 + JSON-ошибку.
    if (ct.includes('application/json')) {
      up.resume();
      if (!res.headersSent) res.status(502).json({ error: 'Bitrix отклонил загрузку файла (нет доступа к файлу через вебхук).' });
      return;
    }
    if (up.statusCode !== 200) { up.resume(); if (!res.headersSent) res.status(502).end('Bitrix ' + up.statusCode); return; }
    if (ct) res.setHeader('Content-Type', ct);
    if (up.headers['content-disposition']) res.setHeader('Content-Disposition', up.headers['content-disposition']);
    if (up.headers['content-length']) res.setHeader('Content-Length', up.headers['content-length']);
    up.pipe(res);
  });
  rq.on('error', e => { if (!res.headersSent) res.status(502).end('fetch error: ' + e.message); });
  rq.setTimeout(30000, () => rq.destroy(new Error('timeout')));
}

// GET /api/logistics/file?e=<entityTypeId>&id=<itemId>&f=<fieldCode>
// Берёт СВЕЖИЙ URL файла из Bitrix на момент клика (кэш борда хранит только ссылку
// на поле, не сам URL — подпись Bitrix недолговечна) и стримит файл через себя,
// поэтому браузеру не нужна интранет-сессия Bitrix.
router.get('/file', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const e = parseInt(req.query.e, 10), id = parseInt(req.query.id, 10), f = String(req.query.f || '');
    const { FILE_FIELDS, fileUrl, bitrixOrigin } = require('../logistics-calc');
    if (!e || !id || !FILE_FIELDS.has(f)) return res.status(400).send('bad request');
    const { b24 } = require('../bitrix');
    const { result } = await b24('crm.item.get', { entityTypeId: e, id });
    const item = result && result.item;
    if (!item) return res.status(404).send('Объект не найден');
    let val = item[f];
    if (Array.isArray(val)) val = val[0];
    if (!val) return res.status(404).send('Файл не заполнен');
    let link = (val && (val.urlMachine || val.downloadUrl || val.url)) || null;
    if (!link) return res.status(404).send('Файл недоступен');
    if (link.startsWith('/')) { const o = bitrixOrigin(); if (o) link = o + link; }
    pipeDownload(link, res);
  } catch (err) {
    console.error('GET /api/logistics/file error:', err.message);
    res.status(502).send('Ошибка получения файла: ' + err.message);
  }
});

// GET /api/logistics/board — все заказы с вехами, ETA, прогрессом (кэш 10 мин).
router.get('/board', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getBoard } = require('../logistics-calc');
    res.json(await getBoard(req.query.force === '1'));
  } catch (e) {
    console.error('GET /api/logistics/board error:', e.message);
    res.status(500).json({ error: 'Не удалось загрузить: ' + e.message });
  }
});

module.exports = { router };

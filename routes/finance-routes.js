// Финансовые модули (данные из 1С). Пока 1С не настроена — работают на мок-данных.
// Доступ к странице гейтится грантом модуля (requireModule('DEBT') и т.д.);
// API открыт авторизованным (как в остальных модулях) — кто видит страницу,
// тому выдан грант.
const express = require('express');
const router = express.Router();
const { requireAuth, requireModuleApi, isAdminLike, auditLog } = require('../auth');
const { EMPLOYEE_DEPT } = require('../dept-map');
const { USERS } = require('../constants');
const { memo, bust } = require('../cache');
// Кэш финансовых бордов на 2 мин (данные 1С обновляются синком пару раз в день):
// десять человек, открывших Дебет в одно окно, читают Postgres один раз.
const FIN_TTL = 120 * 1000;

const VIEW = []; // любой авторизованный, дошедший до API (страница под грантом)

// Журналируем РУЧНОЕ обновление финмодуля (кнопка «Обновить») — чтобы в журнале
// было видно и ручные запуски, а не только плановый автосинк. Одна запись на клик.
async function logManualRefresh(req, module, r) {
  try {
    const ok = !!(r && r.ok);
    await auditLog(
      (req.user && req.user.id) || null, (req.user && req.user.username) || null,
      ok ? 'FIN_MANUAL_REFRESH' : 'FIN_MANUAL_REFRESH_FAIL', null,
      { модуль: module, итог: ok ? `успешно${r.count != null ? ' · ' + r.count : ''}` : `сбой: ${String((r && r.error) || 'неизвестно').slice(0, 200)}` },
      req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']
    );
  } catch (e) { /* журнал — не критичен */ }
}

// Один 1С-синк за раз. Если обновление уже идёт — второе НЕ запускаем, отвечаем 409
// с понятным сообщением. Плюс жёсткий таймаут: зависший запрос к 1С не держит кнопку
// вечно и гарантированно пишет результат в журнал.
let fbusy = false, fbusySince = 0, fbusyWhat = '';
const FBUSY_STALE_MS = 15 * 60 * 1000;      // «идёт» дольше — считаем залипшим, сбрасываем
const FREFRESH_TIMEOUT_MS = 6 * 60 * 1000;  // потолок на один модуль
function fbusyActive() { if (fbusy && Date.now() - fbusySince > FBUSY_STALE_MS) { fbusy = false; fbusyWhat = ''; } return fbusy; }
const fWithTimeout = (p, ms, label) => Promise.race([
  Promise.resolve().then(() => p),
  new Promise((_, rej) => setTimeout(() => rej(new Error(`таймаут модуля ${label} (${Math.round(ms / 1000)}с)`)), ms)),
]);
async function doManualRefresh(req, res, module, fn) {
  if (fbusyActive()) {
    const sec = Math.round((Date.now() - fbusySince) / 1000);
    return res.status(409).json({ ok: false, busy: true, module: fbusyWhat, sec,
      error: `Сейчас уже идёт обновление${fbusyWhat ? ' («' + fbusyWhat + '»)' : ''} — ${sec} с. Подождите, пока закончится, и попробуйте снова.` });
  }
  fbusy = true; fbusySince = Date.now(); fbusyWhat = module;
  try {
    const r = await fWithTimeout(fn(), FREFRESH_TIMEOUT_MS, module);
    bust('fin:'); // синк обновил зеркала — сбрасываем кэш бордов, чтобы сразу было свежо
    logManualRefresh(req, module, r);
    res.json(r);
  } catch (e) {
    logManualRefresh(req, module, { ok: false, error: e.message });
    res.status(500).json({ error: e.message });
  } finally { fbusy = false; fbusyWhat = ''; }
}

// Текущее состояние синка — чтобы фронт мог показать «идёт обновление» без клика.
router.get('/sync-state', requireAuth(VIEW), (req, res) => {
  const b = fbusyActive();
  res.json({ busy: b, module: b ? fbusyWhat : '', sec: b ? Math.round((Date.now() - fbusySince) / 1000) : 0 });
});

// ── Скоупинг Дебета: менеджеру видны только отделы дебиторки (1С) его оргподразделения.
// Карта: орготдел (EMPLOYEE_DEPT) → отделы дебиторки. Админ/суперадмин — все.
const DEBT_NAZERKE = ['Запчасти и расходники', 'Материаловедение', 'Общелаб', 'Электрохимия'];
const DEBT_DEPTS_BY_ORG = {
  'Сервисный': ['Сервис'],
  'Хроматография': ['Хроматография'],
  'Элементный': ['Элементный'],
  'Тренинг-центр': ['Тренинг-центр'],
  'ОРМ': DEBT_NAZERKE,
  'Электрохимия': DEBT_NAZERKE,
  'Materials': DEBT_NAZERKE,
};
function debtBid(user) {
  if (user && user.bitrix_user_id) return parseInt(user.bitrix_user_id, 10);
  const nm = user && (user.engineer_name || user.display_name);
  if (nm) { const f = Object.entries(USERS).find(([, n]) => n === nm); if (f) return parseInt(f[0], 10); }
  return null;
}
function debtScope(user) {
  const r = user && user.role;
  if (isAdminLike(r) || r === 'coordinator') return null; // админ/суперадмин/координатор — все отделы
  const bid = debtBid(user);
  const org = bid ? EMPLOYEE_DEPT[bid] : null;
  return { departments: (org && DEBT_DEPTS_BY_ORG[org]) || [] }; // нет соответствия → пусто (fail-closed)
}

// ── Дебет (дебиторская задолженность) ───────────────────────────────────────
router.get('/debt', requireAuth(VIEW), async (req, res) => {
  try {
    const scope = debtScope(req.user);
    res.json(await memo('fin:debt:' + JSON.stringify(scope), FIN_TTL, () => require('../finance-debt-calc').getDebtBoard(scope)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/debt/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Дебет', () => require('../finance-debt-calc').syncDebt()));

// ── Комментарии с файлами по договорам Дебета ───────────────────────────────
// Карта «договор → число комментариев» (для бейджей в таблице).
router.get('/debt/comment-counts', requireAuth(VIEW), async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ ok: true, counts: await require('../debt-comments').counts() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Лента комментариев по договору (хронологически).
router.get('/debt/comments', requireAuth(VIEW), async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ ok: true, items: await require('../debt-comments').listComments(req.query.key || '') }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Добавить комментарий (+ файлы, множественно). Не заменяет — добавляет.
router.post('/debt/comments', requireAuth(VIEW), express.json({ limit: '22mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.key) return res.status(400).json({ ok: false, error: 'Не указан договор' });
    const c = await require('../debt-comments').addComment({
      debtKey: b.key, contractor: b.contractor, text: b.text, files: b.files,
      authorId: req.user.id, authorName: req.user.display_name || req.user.username,
    });
    res.json({ ok: true, comment: c });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// Отдать вложение комментария (картинки — inline, остальное — скачиванием).
router.get('/debt/comment-file/:token', requireAuth(VIEW), async (req, res) => {
  try {
    const f = await require('../debt-comments').getFile(req.params.token);
    if (!f || !f.data) return res.status(404).send('нет файла');
    res.set('Content-Type', f.mime || 'application/octet-stream');
    res.set('Content-Disposition', (/^image\//.test(f.mime || '') ? 'inline' : 'attachment') + '; filename="' + encodeURIComponent(f.filename || 'file') + '"');
    res.set('Cache-Control', 'private, max-age=600');
    res.send(Buffer.from(f.data));
  } catch (e) { res.status(500).send('err'); }
});

// ── Склад (остатки на складах, fact_stock) ──────────────────────────────────
router.get('/stock', requireAuth(VIEW), async (req, res) => {
  try { res.json(await memo('fin:stock', FIN_TTL, () => require('../finance-stock-calc').getStockBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Склад', () => require('../finance-stock-calc').syncStock()));
// Реестр неснижаемого запаса: список (любой авторизованный), пометка — только админ.
router.get('/stock/min', requireAuth(VIEW), async (req, res) => {
  try { res.json({ items: await require('../finance-stock-calc').listMinStock() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/min', requireAuth(VIEW), express.json(), async (req, res) => {
  try {
    if (!['admin', 'superadmin', 'store'].includes(req.user.role)) return res.status(403).json({ error: 'Только для админа/менеджера склада' });
    const b = req.body || {}; const calc = require('../finance-stock-calc');
    const uname = req.user && req.user.username;
    let out;
    if (b.codes != null) out = await calc.bulkMinStock(b.codes, uname);
    else out = await calc.setMinStock(b.itemCode, b.on !== false, { name: b.name, minQty: b.minQty, note: b.note, thresholdPct: b.thresholdPct }, uname);
    bust('fin:stock');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Коды групп (одинаковые позиции под разными номерами) ─────────────────────
const STOCK_EDIT = ['admin', 'superadmin', 'store'];
router.get('/stock/codes', requireAuth(VIEW), async (req, res) => {
  try { res.json({ items: await require('../finance-stock-calc').listCodes() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/codes', requireAuth(VIEW), express.json(), async (req, res) => {
  try {
    if (!STOCK_EDIT.includes(req.user.role)) return res.status(403).json({ error: 'Только для админа/менеджера склада' });
    const b = req.body || {}; const calc = require('../finance-stock-calc');
    const out = await calc.upsertCode(b.code, { name: b.name, minQty: b.minQty, thresholdPct: b.thresholdPct }, req.user && req.user.username);
    bust('fin:stock');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/codes/delete', requireAuth(VIEW), express.json(), async (req, res) => {
  try {
    if (!STOCK_EDIT.includes(req.user.role)) return res.status(403).json({ error: 'Только для админа/менеджера склада' });
    const out = await require('../finance-stock-calc').deleteCode((req.body || {}).code);
    bust('fin:stock');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/assign-code', requireAuth(VIEW), express.json(), async (req, res) => {
  try {
    if (!STOCK_EDIT.includes(req.user.role)) return res.status(403).json({ error: 'Только для админа/менеджера склада' });
    const b = req.body || {};
    const out = await require('../finance-stock-calc').assignItemCode(b.itemCode, b.code, req.user && req.user.username);
    bust('fin:stock');
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Диагностика сырого ответа 1С по складу (увидеть ключ наименования) — только админ.
router.get('/stock/raw', requireAuth(VIEW), async (req, res) => {
  try {
    if (!isAdminLike(req.user.role)) return res.status(403).json({ error: 'Только для админа' });
    res.json(await require('../finance-stock-calc').probeStockRaw(req.query.limit));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Авансы (счёт 3510 + оплаты 1210/1010-1030) ──────────────────────────────
// Авансы — данные НЕ скоупятся (getAdvancesBoard отдаёт всё). Поэтому гейтим
// строго по модулю ADV (а не «любой авторизованный»): так скрытый для ТЦ модуль
// нельзя получить и напрямую по URL. Было requireAuth(VIEW=[]) — любой вошедший.
router.get('/advances', requireModuleApi('ADV'), async (req, res) => {
  try { res.json(await memo('fin:advances', FIN_TTL, () => require('../finance-advances-calc').getAdvancesBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/advances/refresh', requireModuleApi('ADV'), (req, res) => doManualRefresh(req, res, 'Авансы', () => require('../finance-advances-calc').syncAdvances()));

// ── Cash Flow (13-недельный прогноз ликвидности; приток из Дебета 1210) ──────
// Cash Flow — так же не скоупится; гейтим по модулю CASHFLOW (был requireAuth(VIEW=[])).
router.get('/cashflow', requireModuleApi('CASHFLOW'), async (req, res) => {
  try { res.json(await memo('fin:cashflow', FIN_TTL, () => require('../finance-cashflow-calc').getCashflowBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/cashflow/refresh', requireModuleApi('CASHFLOW'), (req, res) => doManualRefresh(req, res, 'Cash Flow', () => require('../finance-cashflow-calc').syncCashflow()));

// ── Качество (сверка контрактов 1С ↔ сделок Битрикса) ───────────────────────
router.get('/quality', requireAuth(VIEW), async (req, res) => {
  try { res.json(await memo('fin:quality', FIN_TTL, () => require('../finance-quality-calc').getQualityBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/quality/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Качество', () => require('../finance-quality-calc').syncQuality()));

module.exports = { router };

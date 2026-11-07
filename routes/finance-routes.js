// Финансовые модули (данные из 1С). Пока 1С не настроена — работают на мок-данных.
// Доступ к странице гейтится грантом модуля (requireModule('DEBT') и т.д.);
// API открыт авторизованным (как в остальных модулях) — кто видит страницу,
// тому выдан грант.
const express = require('express');
const router = express.Router();
const { requireAuth, isAdminLike, auditLog } = require('../auth');
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

// ── Склад (остатки на складах, fact_stock) ──────────────────────────────────
router.get('/stock', requireAuth(VIEW), async (req, res) => {
  try { res.json(await memo('fin:stock', FIN_TTL, () => require('../finance-stock-calc').getStockBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Склад', () => require('../finance-stock-calc').syncStock()));

// ── Авансы (счёт 3510 + оплаты 1210/1010-1030) ──────────────────────────────
router.get('/advances', requireAuth(VIEW), async (req, res) => {
  try { res.json(await memo('fin:advances', FIN_TTL, () => require('../finance-advances-calc').getAdvancesBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/advances/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Авансы', () => require('../finance-advances-calc').syncAdvances()));

// ── Cash Flow (13-недельный прогноз ликвидности; приток из Дебета 1210) ──────
router.get('/cashflow', requireAuth(VIEW), async (req, res) => {
  try { res.json(await memo('fin:cashflow', FIN_TTL, () => require('../finance-cashflow-calc').getCashflowBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/cashflow/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Cash Flow', () => require('../finance-cashflow-calc').syncCashflow()));

// ── Качество (сверка контрактов 1С ↔ сделок Битрикса) ───────────────────────
router.get('/quality', requireAuth(VIEW), async (req, res) => {
  try { res.json(await memo('fin:quality', FIN_TTL, () => require('../finance-quality-calc').getQualityBoard())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/quality/refresh', requireAuth(VIEW), (req, res) => doManualRefresh(req, res, 'Качество', () => require('../finance-quality-calc').syncQuality()));

module.exports = { router };

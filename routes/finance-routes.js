// Финансовые модули (данные из 1С). Пока 1С не настроена — работают на мок-данных.
// Доступ к странице гейтится грантом модуля (requireModule('DEBT') и т.д.);
// API открыт авторизованным (как в остальных модулях) — кто видит страницу,
// тому выдан грант.
const express = require('express');
const router = express.Router();
const { requireAuth, isAdminLike, auditLog } = require('../auth');
const { EMPLOYEE_DEPT } = require('../dept-map');
const { USERS } = require('../constants');

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
  try { res.json(await require('../finance-debt-calc').getDebtBoard(debtScope(req.user))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/debt/refresh', requireAuth(VIEW), async (req, res) => {
  try { const r = await require('../finance-debt-calc').syncDebt(); logManualRefresh(req, 'Дебет', r); res.json(r); }
  catch (e) { logManualRefresh(req, 'Дебет', { ok: false, error: e.message }); res.status(500).json({ error: e.message }); }
});

// ── Склад (остатки на складах, fact_stock) ──────────────────────────────────
router.get('/stock', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-stock-calc').getStockBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/refresh', requireAuth(VIEW), async (req, res) => {
  try { const r = await require('../finance-stock-calc').syncStock(); logManualRefresh(req, 'Склад', r); res.json(r); }
  catch (e) { logManualRefresh(req, 'Склад', { ok: false, error: e.message }); res.status(500).json({ error: e.message }); }
});

// ── Авансы (счёт 3510 + оплаты 1210/1010-1030) ──────────────────────────────
router.get('/advances', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-advances-calc').getAdvancesBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/advances/refresh', requireAuth(VIEW), async (req, res) => {
  try { const r = await require('../finance-advances-calc').syncAdvances(); logManualRefresh(req, 'Авансы', r); res.json(r); }
  catch (e) { logManualRefresh(req, 'Авансы', { ok: false, error: e.message }); res.status(500).json({ error: e.message }); }
});

// ── Cash Flow (13-недельный прогноз ликвидности; приток из Дебета 1210) ──────
router.get('/cashflow', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-cashflow-calc').getCashflowBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/cashflow/refresh', requireAuth(VIEW), async (req, res) => {
  try { const r = await require('../finance-cashflow-calc').syncCashflow(); logManualRefresh(req, 'Cash Flow', r); res.json(r); }
  catch (e) { logManualRefresh(req, 'Cash Flow', { ok: false, error: e.message }); res.status(500).json({ error: e.message }); }
});

// ── Качество (сверка контрактов 1С ↔ сделок Битрикса) ───────────────────────
router.get('/quality', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-quality-calc').getQualityBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/quality/refresh', requireAuth(VIEW), async (req, res) => {
  try { const r = await require('../finance-quality-calc').syncQuality(); logManualRefresh(req, 'Качество', r); res.json(r); }
  catch (e) { logManualRefresh(req, 'Качество', { ok: false, error: e.message }); res.status(500).json({ error: e.message }); }
});

module.exports = { router };

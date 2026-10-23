// Финансовые модули (данные из 1С). Пока 1С не настроена — работают на мок-данных.
// Доступ к странице гейтится грантом модуля (requireModule('DEBT') и т.д.);
// API открыт авторизованным (как в остальных модулях) — кто видит страницу,
// тому выдан грант.
const express = require('express');
const router = express.Router();
const { requireAuth, isAdminLike } = require('../auth');
const { EMPLOYEE_DEPT } = require('../dept-map');
const { USERS } = require('../constants');

const VIEW = []; // любой авторизованный, дошедший до API (страница под грантом)

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
  try { res.json(await require('../finance-debt-calc').syncDebt()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Склад (остатки на складах, fact_stock) ──────────────────────────────────
router.get('/stock', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-stock-calc').getStockBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/stock/refresh', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-stock-calc').syncStock()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Авансы (счёт 3510 + оплаты 1210/1010-1030) ──────────────────────────────
router.get('/advances', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-advances-calc').getAdvancesBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/advances/refresh', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-advances-calc').syncAdvances()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cash Flow (13-недельный прогноз ликвидности; приток из Дебета 1210) ──────
router.get('/cashflow', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-cashflow-calc').getCashflowBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/cashflow/refresh', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-cashflow-calc').syncCashflow()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Качество (сверка контрактов 1С ↔ сделок Битрикса) ───────────────────────
router.get('/quality', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-quality-calc').getQualityBoard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/quality/refresh', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-quality-calc').syncQuality()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { router };

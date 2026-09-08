// Финансовые модули (данные из 1С). Пока 1С не настроена — работают на мок-данных.
// Доступ к странице гейтится грантом модуля (requireModule('DEBT') и т.д.);
// API открыт авторизованным (как в остальных модулях) — кто видит страницу,
// тому выдан грант.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

const VIEW = []; // любой авторизованный, дошедший до API (страница под грантом)

// ── Дебет (дебиторская задолженность) ───────────────────────────────────────
router.get('/debt', requireAuth(VIEW), async (req, res) => {
  try { res.json(await require('../finance-debt-calc').getDebtBoard()); }
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

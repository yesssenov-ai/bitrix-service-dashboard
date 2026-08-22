const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

// Модуль «План продаж» доступен по гранту модуля (страница закрыта requireModule),
// а API — любому авторизованному с доступом; ограничим ролями просмотра аналитики.
const VIEW_ROLES = ['admin', 'coordinator', 'manager', 'store', 'accountant'];

// GET /api/plansales — обогащённый список доконтрактных сделок с планируемой датой.
router.get('/', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { getPlanSales } = require('../plansales-calc');
    res.set('Cache-Control', 'no-store');
    res.json(await getPlanSales());
  } catch (e) {
    console.error('GET /api/plansales error:', e.message);
    res.status(500).json({ error: e.message, deals: [], meta: {} });
  }
});

// POST /api/plansales/resync — полная пересинхронизация зеркала сделок (админ).
// Нужна разово после релиза, чтобы у существующих сделок заполнились новые поля
// (планируемый срок покупки, «наиболее вероятная»). Запускается в фоне.
let _resyncBusy = false;
router.post('/resync', requireAuth(['admin']), async (req, res) => {
  if (_resyncBusy) return res.json({ ok: true, started: false, busy: true });
  _resyncBusy = true;
  res.json({ ok: true, started: true });
  (async () => {
    try {
      const { fullSync } = require('../stats-sync');
      await fullSync();
    } catch (e) { console.error('plansales resync error:', e.message); }
    finally { _resyncBusy = false; }
  })();
});

module.exports = { router };

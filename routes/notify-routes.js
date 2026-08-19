// Глобальные уведомления/бейдж: доступны ЛЮБОМУ авторизованному пользователю
// (не только закупщикам) — бейдж на иконке приложения нужен всем.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

// Число невыполненных действий пользователя по всем модулям (для бейджа).
router.get('/pending-count', requireAuth(), async (req, res) => {
  try {
    const bid = req.user && req.user.bitrix_user_id;
    if (!bid) return res.json({ count: 0, breakdown: {}, items: [] });
    res.set('Cache-Control', 'no-store');
    res.json(await require('../pending-actions').pendingForBid(bid));
  } catch (e) {
    console.error('GET /api/notify/pending-count error:', e.message);
    res.status(500).json({ count: 0, error: e.message });
  }
});

// Публичный VAPID-ключ для оформления подписки на пуши.
router.get('/push-key', requireAuth(), (req, res) => {
  const push = require('../push');
  res.json({ enabled: push.enabled(), key: push.enabled() ? push.publicKey() : null });
});

// Сохранить подписку на пуши текущего пользователя.
router.post('/subscribe', requireAuth(), express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const bid = req.user && req.user.bitrix_user_id;
    const sub = (req.body && req.body.subscription) || req.body;
    res.json(await require('../push').saveSubscription(bid, sub));
  } catch (e) {
    console.error('POST /api/notify/subscribe error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

// Отписаться (endpoint).
router.post('/unsubscribe', requireAuth(), express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const endpoint = (req.body && req.body.endpoint) || '';
    res.json(await require('../push').removeSubscription(endpoint));
  } catch (e) {
    console.error('POST /api/notify/unsubscribe error:', e.message);
    res.status(400).json({ error: e.message });
  }
});

module.exports = { router };

// Мониторинг системы — API только для суперадминов.
const express = require('express');
const router = express.Router();
const { requireAuth, pool, kickUser, auditLog } = require('../auth');
const mon = require('../monitoring');

const SA = ['superadmin'];

// Сводка live + топы эндпоинтов
router.get('/overview', requireAuth(SA), (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ ok: true, overview: mon.overview(pool), top: mon.topEndpoints() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Онлайн-пользователи
router.get('/online', requireAuth(SA), (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ ok: true, users: mon.onlineList() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Здоровье зависимостей (Bitrix / 1С / БД) — кэш внутри
router.get('/deps', requireAuth(SA), async (req, res) => {
  try { res.json({ ok: true, deps: await mon.deps(pool) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// История метрик (24ч / 7д) — с серверным кэшем, грузится по запросу
router.get('/history', requireAuth(SA), async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true }, await mon.history(pool, req.query.range))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Прогноз/ёмкость по трендам + активные алерты
router.get('/forecast', requireAuth(SA), async (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true, alerts: mon.activeAlerts() }, await mon.forecast(pool))); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Завершить сессии пользователя («выкинуть»)
router.post('/kick/:userId', requireAuth(SA), async (req, res) => {
  try {
    const id = parseInt(req.params.userId, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'Неверный ID' });
    if (id === req.user.id) return res.status(400).json({ ok: false, error: 'Нельзя завершить собственную сессию отсюда' });
    kickUser(id);
    try { await auditLog(req.user.id, req.user.username, 'USER_SESSION_KICKED', null, { targetId: id }, req.ip, req.headers['user-agent']); } catch (e) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

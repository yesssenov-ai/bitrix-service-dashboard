const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');

// Определяем Bitrix-ID автора действия: сначала явная связка (bitrix_user_id из
// карточки пользователя), иначе — по совпадению имени учётки с сотрудником Bitrix.
// Если ничего не нашли — вернём null (тогда автором станет владелец вебхука).
function resolveBitrixId(user) {
  if (!user) return null;
  if (user.bitrix_user_id) return parseInt(user.bitrix_user_id, 10);
  const nm = user.engineer_name || user.display_name;
  if (nm) {
    try {
      const { USERS } = require('../constants');
      const found = Object.entries(USERS).find(([, n]) => n === nm);
      if (found) return parseInt(found[0], 10);
    } catch (e) { /* ignore */ }
  }
  return null;
}

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

// POST /api/plansales/refresh — быстрая инкрементальная синхронизация (как в
// Контрактах): тянет из Bitrix только сделки, изменённые с последней синхронизации.
let _refreshing = false;
router.post('/refresh', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  if (_refreshing) return res.json({ ok: true, running: true, note: 'Обновление уже идёт' });
  _refreshing = true;
  try {
    const { pool } = require('../auth');
    const { rows } = await pool.query('SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals');
    const last = rows[0] && rows[0].t ? new Date(rows[0].t).getTime() : null;
    const sinceMs = (last || (Date.now() - 7 * 86400 * 1000)) - 15 * 60 * 1000; // буфер 15 мин
    const { incrementalSync } = require('../stats-sync');
    const r = await incrementalSync(sinceMs);
    const { rows: r2 } = await pool.query('SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals');
    res.json({ ok: true, updated: r.updated || 0, updatedAt: r2[0] && r2[0].t ? new Date(r2[0].t).toISOString() : null });
  } catch (e) {
    console.error('POST /api/plansales/refresh error:', e.message);
    res.status(500).json({ error: 'Не удалось обновить: ' + e.message });
  } finally { _refreshing = false; }
});

// GET /api/plansales/:id/comments — лента комментариев сделки из Bitrix (таймлайн).
router.get('/:id/comments', requireAuth(VIEW_ROLES), async (req, res) => {
  try {
    const { b24 } = require('../bitrix');
    const { USERS } = require('../constants');
    const id = parseInt(req.params.id, 10);
    const { result } = await b24('crm.timeline.comment.list', {
      filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' }, order: { CREATED: 'DESC' },
    });
    const items = (result || []).map(c => ({
      id: c.ID,
      text: c.COMMENT || '',
      authorId: c.AUTHOR_ID || null,
      author: c.AUTHOR_ID ? (USERS[c.AUTHOR_ID] || ('#' + c.AUTHOR_ID)) : '—',
      created: c.CREATED || null,
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, items });
  } catch (e) {
    console.error('GET /api/plansales/:id/comments error:', e.message);
    res.status(500).json({ error: e.message, items: [] });
  }
});

// POST /api/plansales/:id/comments { text } — добавить комментарий в сделку (в Bitrix).
router.post('/:id/comments', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { b24 } = require('../bitrix');
    const id = parseInt(req.params.id, 10);
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.status(400).json({ error: 'Пустой комментарий' });
    const bid = resolveBitrixId(req.user);
    const fields = { ENTITY_ID: id, ENTITY_TYPE: 'deal' };
    if (bid) {
      fields.AUTHOR_ID = bid;            // автор = текущий пользователь (по связке/имени)
      fields.COMMENT = text;
    } else {
      // Учётка не связана с Bitrix и имя не совпало — иначе автором стал бы
      // владелец вебхука. Сохраняем настоящего автора в тексте комментария.
      const who = (req.user && (req.user.display_name || req.user.engineer_name)) || 'сотрудник ЦУП';
      fields.COMMENT = `[${who}]: ${text}`;
    }
    const { result } = await b24('crm.timeline.comment.add', { fields });
    res.json({ ok: true, id: result, linked: !!bid });
  } catch (e) {
    console.error('POST /api/plansales/:id/comments error:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить комментарий: ' + e.message });
  }
});

// POST /api/plansales/:id/task { title, description, deadline, responsibleId } —
// поставить задачу менеджеру по сделке (создаётся в Bitrix, привязана к сделке).
router.post('/:id/task', requireAuth(VIEW_ROLES), express.json(), async (req, res) => {
  try {
    const { b24 } = require('../bitrix');
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Укажите название задачи' });
    const fields = { TITLE: title, DESCRIPTION: String(b.description || ''), UF_CRM_TASK: ['D_' + id] };
    if (b.responsibleId) fields.RESPONSIBLE_ID = parseInt(b.responsibleId, 10);
    if (b.deadline) fields.DEADLINE = /^\d{4}-\d{2}-\d{2}$/.test(b.deadline) ? (b.deadline + 'T18:00:00') : b.deadline;
    const cby = resolveBitrixId(req.user);
    if (cby) fields.CREATED_BY = cby;
    const { result } = await b24('tasks.task.add', { fields });
    const taskId = result && result.task && (result.task.id || result.task.ID);
    res.json({ ok: true, id: taskId });
  } catch (e) {
    console.error('POST /api/plansales/:id/task error:', e.message);
    res.status(500).json({ error: 'Не удалось создать задачу: ' + e.message });
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

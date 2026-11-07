// «Мои задачи» — персональная канбан-доска. Все карточки приватны: каждый запрос
// жёстко скоупится по user_id из сессии. Колонки, перетаскивание (позиция —
// дробное число), сроки, приоритет, метки, чек-лист и связь со сделкой/заявкой ЦУП.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');

const COLUMNS = ['todo', 'doing', 'done', 'later'];
const LABELS = ['gray', 'red', 'amber', 'green', 'blue', 'violet'];
const REFS = ['deal', 'ticket', 'task', 'company'];
const RECURS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

// Следующий срок для повторяющейся задачи от базовой даты (или от сегодня).
function nextDue(base, recur) {
  const d = base ? new Date(base + 'T00:00:00Z') : new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  if (recur === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (recur === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (recur === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (recur === 'weekdays') { do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); }
  else return null;
  return d.toISOString().slice(0, 10);
}

function cleanChecklist(v) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, 50).map(x => ({ t: String((x && x.t) || '').slice(0, 300), d: !!(x && x.d) }))
    .filter(x => x.t);
}
function rowOut(r) {
  return {
    id: r.id, column: r.column_key, title: r.title, notes: r.notes || '',
    priority: r.priority || 0, due: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
    label: r.label || null, position: Number(r.position) || 0,
    checklist: Array.isArray(r.checklist) ? r.checklist : [],
    refType: r.ref_type || null, refId: r.ref_id || null, refUrl: r.ref_url || null,
    recur: r.recur || null, doneAt: r.done_at || null,
  };
}

// GET / — все неархивные карточки текущего пользователя.
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ticketsmodule_board_cards WHERE user_id=$1 AND archived=FALSE
         ORDER BY column_key, position ASC, id ASC`, [req.user.id]
    );
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, columns: COLUMNS, cards: rows.map(rowOut) });
  } catch (e) { console.error('board list:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// POST / — создать карточку { title, column?, priority?, due?, label?, notes? }.
router.post('/', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ ok: false, error: 'Пустая задача' });
    if (title.length > 500) return res.status(400).json({ ok: false, error: 'Слишком длинный заголовок' });
    const col = COLUMNS.includes(b.column) ? b.column : 'todo';
    const prio = [0, 1, 2, 3].includes(b.priority) ? b.priority : 0;
    const label = LABELS.includes(b.label) ? b.label : null;
    const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : null;
    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_board_cards WHERE user_id=$1 AND column_key=$2 AND archived=FALSE`,
      [req.user.id, col]
    );
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_board_cards (user_id, column_key, title, notes, priority, due_date, label, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, col, title, String(b.notes || '').slice(0, 5000) || null, prio, due, label, mx[0].p]
    );
    res.json({ ok: true, card: rowOut(rows[0]) });
  } catch (e) { console.error('board create:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// POST /from-entity — создать карточку из сущности ЦУП (сделка/заявка/задача).
// Дедуп: если такая уже на доске (не архив) — вернём её, не плодим дубли.
router.post('/from-entity', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const refType = REFS.includes(b.refType) ? b.refType : null;
    const refId = String(b.refId || '').slice(0, 40);
    const title = String(b.title || '').trim().slice(0, 500);
    const refUrl = String(b.refUrl || '').slice(0, 1000) || null;
    if (!refType || !refId || !title) return res.status(400).json({ ok: false, error: 'Нужны refType, refId, title' });
    const existing = await pool.query(
      `SELECT * FROM ticketsmodule_board_cards WHERE user_id=$1 AND ref_type=$2 AND ref_id=$3 AND archived=FALSE LIMIT 1`,
      [req.user.id, refType, refId]
    );
    if (existing.rows.length) return res.json({ ok: true, card: rowOut(existing.rows[0]), existed: true });
    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_board_cards WHERE user_id=$1 AND column_key='todo' AND archived=FALSE`,
      [req.user.id]
    );
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_board_cards (user_id, column_key, title, position, ref_type, ref_id, ref_url)
       VALUES ($1,'todo',$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, title, mx[0].p, refType, refId, refUrl]
    );
    res.json({ ok: true, card: rowOut(rows[0]) });
  } catch (e) { console.error('board from-entity:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// PATCH /:id — частичное обновление (только владелец).
router.patch('/:id(\\d+)', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const id = parseInt(req.params.id, 10), uid = req.user.id;
    // Для повтора: узнаём прежнее состояние, если карточку завершают.
    let prior = null;
    if (b.column === 'done') {
      const pr = await pool.query('SELECT * FROM ticketsmodule_board_cards WHERE id=$1 AND user_id=$2', [id, uid]);
      prior = pr.rows[0] || null;
    }
    const sets = [], vals = [], add = (sql, v) => { vals.push(v); sets.push(`${sql}=$${vals.length}`); };
    if (typeof b.title === 'string') { const t = b.title.trim(); if (t) add('title', t.slice(0, 500)); }
    if ('notes' in b) add('notes', String(b.notes || '').slice(0, 5000) || null);
    if ([0, 1, 2, 3].includes(b.priority)) add('priority', b.priority);
    if ('due' in b) add('due_date', /^\d{4}-\d{2}-\d{2}$/.test(b.due || '') ? b.due : null);
    if ('label' in b) add('label', LABELS.includes(b.label) ? b.label : null);
    if ('recur' in b) add('recur', RECURS.includes(b.recur) && b.recur !== 'none' ? b.recur : null);
    if (typeof b.position === 'number' && isFinite(b.position)) add('position', b.position);
    if ('checklist' in b) { const c = cleanChecklist(b.checklist); if (c) add('checklist', JSON.stringify(c)); }
    if (COLUMNS.includes(b.column)) {
      add('column_key', b.column);
      add('done_at', b.column === 'done' ? new Date().toISOString() : null);
    }
    if ('archived' in b) add('archived', !!b.archived);
    if (!sets.length) return res.status(400).json({ ok: false, error: 'Нечего менять' });
    sets.push('updated_at=NOW()');
    vals.push(id); vals.push(uid);
    const { rows } = await pool.query(
      `UPDATE ticketsmodule_board_cards SET ${sets.join(', ')} WHERE id=$${vals.length - 1} AND user_id=$${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Не найдено' });

    // Завершили повторяющуюся задачу (и она не была завершена раньше) → создаём следующую.
    let spawned = null;
    if (prior && prior.column_key !== 'done' && prior.recur && prior.recur !== 'none') {
      const base = prior.due_date ? new Date(prior.due_date).toISOString().slice(0, 10) : null;
      const nd = nextDue(base, prior.recur);
      const cl = Array.isArray(prior.checklist) ? prior.checklist.map(x => ({ t: x.t, d: false })) : [];
      const { rows: mx } = await pool.query(
        `SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_board_cards WHERE user_id=$1 AND column_key='todo' AND archived=FALSE`, [uid]);
      const ins = await pool.query(
        `INSERT INTO ticketsmodule_board_cards (user_id, column_key, title, notes, priority, due_date, label, position, checklist, recur, ref_type, ref_id, ref_url)
         VALUES ($1,'todo',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [uid, prior.title, prior.notes, prior.priority, nd, prior.label, mx[0].p, JSON.stringify(cl), prior.recur, prior.ref_type, prior.ref_id, prior.ref_url]
      );
      spawned = rowOut(ins.rows[0]);
    }
    res.json({ ok: true, card: rowOut(rows[0]), spawned });
  } catch (e) { console.error('board patch:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /:id — удалить карточку (только владелец).
router.delete('/:id(\\d+)', requireAuth(), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM ticketsmodule_board_cards WHERE id=$1 AND user_id=$2',
      [parseInt(req.params.id, 10), req.user.id]);
    res.json({ ok: !!rowCount });
  } catch (e) { console.error('board delete:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// Помощник для «Моего дня» и дайджеста: задачи на сегодня/просроченные (не done/не архив).
async function boardDueForUser(userId) {
  const { rows } = await pool.query(
    `SELECT id, title, due_date, priority FROM ticketsmodule_board_cards
      WHERE user_id=$1 AND archived=FALSE AND column_key <> 'done'
        AND due_date IS NOT NULL AND due_date <= CURRENT_DATE
      ORDER BY due_date ASC, priority DESC LIMIT 20`, [userId]
  );
  const today = new Date().toISOString().slice(0, 10);
  return rows.map(r => ({
    id: r.id, title: r.title,
    due: r.due_date ? new Date(r.due_date).toISOString().slice(0, 10) : null,
    overdue: r.due_date ? (new Date(r.due_date).toISOString().slice(0, 10) < today) : false,
    priority: r.priority || 0,
  }));
}

module.exports = { router, boardDueForUser };

// «Мои задачи» — персональная канбан-доска. Все карточки приватны: каждый запрос
// жёстко скоупится по user_id из сессии. Колонки, перетаскивание (позиция —
// дробное число), сроки, приоритет, метки, чек-лист и связь со сделкой/заявкой ЦУП.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
let notif = null; try { notif = require('../notifications'); } catch (e) { /* уведомления опциональны */ }

const COLUMNS = ['todo', 'doing', 'done', 'later'];
const LABELS = ['gray', 'red', 'amber', 'green', 'blue', 'violet'];
const REFS = ['deal', 'ticket', 'task', 'company'];
const RECURS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const DASH = () => process.env.DASH_URL || 'https://nms.prolabsupport.kz';
const esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
const looksEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));

// Вложение к комментарию (как в обратной связи): картинка/PDF, base64 data URL.
const ATTACH_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i;
const EXT_OF = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' };
const MAX_ATTACH = 6 * 1024 * 1024;
function parseAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(a.data || ''));
  if (!m) return null;
  const type = m[1].toLowerCase();
  if (!ATTACH_MIME.test(type)) throw new Error('Можно картинку или PDF');
  if (Math.floor((m[2].length * 3) / 4) > MAX_ATTACH) throw new Error('Файл больше 6 МБ');
  const name = (String(a.name || '').replace(/[\r\n]/g, '').slice(0, 200)) || ('attachment.' + (EXT_OF[type] || 'bin'));
  return { data: 'data:' + type + ';base64,' + m[2], name, type };
}

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
    remind: r.remind_at ? new Date(r.remind_at).toISOString() : null,
    assignedBy: r.assigned_by || null, assignedByName: r.assigned_by_name || null,
    comments: r.comments_count != null ? Number(r.comments_count) : 0,
  };
}

// GET / — все неархивные карточки текущего пользователя.
router.get('/', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.display_name AS assigned_by_name,
              (SELECT COUNT(*) FROM ticketsmodule_board_comments bc WHERE bc.card_id=c.id) AS comments_count
         FROM ticketsmodule_board_cards c
         LEFT JOIN ticketsmodule_users u ON u.id = c.assigned_by
        WHERE c.user_id=$1 AND c.archived=FALSE
        ORDER BY c.column_key, c.position ASC, c.id ASC`, [req.user.id]
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
    if ('remind' in b) { const iso = b.remind && !isNaN(Date.parse(b.remind)) ? new Date(b.remind).toISOString() : null; add('remind_at', iso); add('reminded_at', null); }
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

// GET /users — список коллег для «поручить» (активные, кроме себя).
router.get('/users', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, display_name, username FROM ticketsmodule_users WHERE active=true AND id <> $1 ORDER BY display_name', [req.user.id]);
    res.json({ ok: true, users: rows.map(r => ({ id: r.id, name: r.display_name || r.username })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /:id/assign { toUserId } — поручить задачу коллеге: копия на его доску + уведомление.
router.post('/:id(\\d+)/assign', requireAuth(), express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), uid = req.user.id;
    const toUserId = parseInt(req.body && req.body.toUserId, 10);
    if (!toUserId || toUserId === uid) return res.status(400).json({ ok: false, error: 'Выберите коллегу' });
    const pr = await pool.query('SELECT * FROM ticketsmodule_board_cards WHERE id=$1 AND user_id=$2', [id, uid]);
    if (!pr.rows.length) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const c = pr.rows[0];
    const tu = await pool.query('SELECT id, display_name, username, bitrix_user_id FROM ticketsmodule_users WHERE id=$1 AND active=true', [toUserId]);
    if (!tu.rows.length) return res.status(400).json({ ok: false, error: 'Коллега не найден' });
    const target = tu.rows[0];
    const cl = Array.isArray(c.checklist) ? c.checklist.map(x => ({ t: x.t, d: false })) : [];
    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(position),0)+1 AS p FROM ticketsmodule_board_cards WHERE user_id=$1 AND column_key='todo' AND archived=FALSE`, [toUserId]);
    await pool.query(
      `INSERT INTO ticketsmodule_board_cards (user_id, column_key, title, notes, priority, due_date, label, position, checklist, ref_type, ref_id, ref_url, assigned_by)
       VALUES ($1,'todo',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [toUserId, c.title, c.notes, c.priority, c.due_date, c.label, mx[0].p, JSON.stringify(cl), c.ref_type, c.ref_id, c.ref_url, uid]
    );
    // Уведомление получателю (не блокирует ответ критично).
    try {
      const fromName = req.user.display_name || req.user.username;
      const text = `📋 <b>Вам поручили задачу</b>\nОт: ${esc(fromName)}\n\n${esc(c.title)}\n\n🔗 <a href="${DASH()}/board.html">Открыть «Мои задачи»</a>`;
      let sent = false;
      if (notif && notif.tgTo && target.bitrix_user_id) {
        const tl = await pool.query('SELECT telegram_chat_id FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [target.bitrix_user_id]);
        if (tl.rows.length) sent = await notif.tgTo(tl.rows[0].telegram_chat_id, text);
      }
      if (!sent && notif && notif.sendEmailTo && looksEmail(target.username)) {
        await notif.sendEmailTo(target.username, 'ЦУП · Вам поручили задачу',
          `<p>📋 <b>Вам поручили задачу</b> · от ${esc(fromName)}</p><p style="font-size:15px">${esc(c.title)}</p><p><a href="${DASH()}/board.html">Открыть «Мои задачи»</a></p>`);
      }
    } catch (e) { console.warn('assign notify:', e.message); }
    res.json({ ok: true, to: target.display_name || target.username });
  } catch (e) { console.error('board assign:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// GET /:id/comments — комментарии карточки (только владелец карточки).
router.get('/:id(\\d+)/comments', requireAuth(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const own = await pool.query('SELECT id FROM ticketsmodule_board_cards WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const { rows } = await pool.query(
      `SELECT id, user_id, display_name, text, (attachment_data IS NOT NULL) AS has_att, attachment_name, attachment_type, created_at
         FROM ticketsmodule_board_comments WHERE card_id=$1 ORDER BY created_at ASC LIMIT 200`, [id]);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, comments: rows.map(r => ({ id: r.id, userId: r.user_id, name: r.display_name || '—', text: r.text || '', hasAttachment: r.has_att, attachmentName: r.attachment_name || null, createdAt: r.created_at })) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /:id/comments { text?, attachment? } — добавить комментарий/вложение.
router.post('/:id(\\d+)/comments', requireAuth(), express.json({ limit: '9mb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10), b = req.body || {};
    const own = await pool.query('SELECT id FROM ticketsmodule_board_cards WHERE id=$1 AND user_id=$2', [id, req.user.id]);
    if (!own.rows.length) return res.status(404).json({ ok: false, error: 'Не найдено' });
    const text = String(b.text || '').trim().slice(0, 4000);
    let att = null; try { att = parseAttachment(b.attachment); } catch (ae) { return res.status(400).json({ ok: false, error: ae.message }); }
    if (!text && !att) return res.status(400).json({ ok: false, error: 'Пустой комментарий' });
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_board_comments (card_id, user_id, display_name, text, attachment_data, attachment_name, attachment_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [id, req.user.id, req.user.display_name || req.user.username, text || null, att ? att.data : null, att ? att.name : null, att ? att.type : null]);
    res.json({ ok: true, comment: { id: rows[0].id, userId: req.user.id, name: req.user.display_name || req.user.username, text, hasAttachment: !!att, attachmentName: att ? att.name : null, createdAt: rows[0].created_at } });
  } catch (e) { console.error('board comment:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// GET /comment/:cid/attachment — отдать вложение комментария (только владелец карточки).
router.get('/comment/:cid(\\d+)/attachment', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT bc.attachment_data, bc.attachment_name, bc.attachment_type
         FROM ticketsmodule_board_comments bc
         JOIN ticketsmodule_board_cards c ON c.id = bc.card_id
        WHERE bc.id=$1 AND c.user_id=$2`, [parseInt(req.params.cid, 10), req.user.id]);
    const r = rows[0];
    if (!r || !r.attachment_data) return res.status(404).send('Нет вложения');
    const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(r.attachment_data);
    if (!m) return res.status(404).send('Повреждено');
    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', r.attachment_type || m[1] || 'application/octet-stream');
    res.set('Content-Disposition', `${req.query.dl ? 'attachment' : 'inline'}; filename="${(r.attachment_name || 'file').replace(/[^\w.\-]+/g, '_')}"`);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(buf);
  } catch (e) { res.status(500).send(e.message); }
});

// Планировщик: разослать напоминания, у которых наступило время (remind_at<=now).
async function sendDueReminders() {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, u.username, u.bitrix_user_id, tl.telegram_chat_id
       FROM ticketsmodule_board_cards c
       JOIN ticketsmodule_users u ON u.id = c.user_id
       LEFT JOIN ticketsmodule_telegram_links tl ON tl.bitrix_user_id = u.bitrix_user_id
      WHERE c.remind_at IS NOT NULL AND c.reminded_at IS NULL AND c.archived=FALSE
        AND c.column_key <> 'done' AND c.remind_at <= NOW()
      ORDER BY c.remind_at ASC LIMIT 100`);
  let sent = 0;
  for (const r of rows) {
    try {
      const text = `⏰ <b>Напоминание</b>\n${esc(r.title)}\n\n🔗 <a href="${DASH()}/board.html">Открыть «Мои задачи»</a>`;
      let ok = false;
      if (notif && notif.tgTo && r.telegram_chat_id) ok = await notif.tgTo(r.telegram_chat_id, text);
      if (!ok && notif && notif.sendEmailTo && looksEmail(r.username)) {
        await notif.sendEmailTo(r.username, 'ЦУП · Напоминание по задаче',
          `<p>⏰ <b>Напоминание</b></p><p style="font-size:15px">${esc(r.title)}</p><p><a href="${DASH()}/board.html">Открыть «Мои задачи»</a></p>`);
      }
      if (ok || true) sent++;
    } catch (e) { console.warn('reminder', r.id, e.message); }
    await pool.query('UPDATE ticketsmodule_board_cards SET reminded_at=NOW() WHERE id=$1', [r.id]);
  }
  if (rows.length) console.log('⏰ board reminders sent:', sent);
  return { due: rows.length, sent };
}

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

module.exports = { router, boardDueForUser, sendDueReminders };

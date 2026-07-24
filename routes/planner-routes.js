const express = require('express');
const router = express.Router();
const { pool, requireAuth } = require('../auth');

// All start/end values from the client are naive "YYYY-MM-DDTHH:mm" strings
// (no timezone) representing local Kazakhstan wall-clock time. We must be
// explicit about that on both sides of Postgres, since a bare TIMESTAMPTZ
// write/read without this would silently assume UTC and shift every time by
// several hours.
const TZ = 'Asia/Almaty';

const SELECT_COLS = `
  id, group_id, resource, title, type,
  to_char(start_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI') AS start_str,
  to_char(end_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI') AS end_str,
  all_day, confirmed, note, fields, clients, bitrix_item_id, source
`;

// ── Helpers ───────────────────────────────────────────────────────────────
function rowToEvent(r) {
  return {
    id: r.id,
    groupId: r.group_id,
    resource: r.resource,
    title: r.title,
    type: r.type,
    start: r.start_str,
    end: r.end_str,
    allDay: r.all_day,
    confirmed: r.confirmed,
    note: r.note,
    fields: r.fields || {},
    clients: r.clients || [],
    bitrixItemId: r.bitrix_item_id,
    source: r.source,
  };
}

async function insertOne(client, { resource, title, type, start, end, allDay, confirmed, note, fields, clients, createdBy, bitrixItemId, source }) {
  const { rows } = await client.query(
    `INSERT INTO ticketsmodule_planner_events
      (group_id, resource, title, type, start_at, end_at, all_day, confirmed, note, fields, clients, created_by, bitrix_item_id, source)
     VALUES (0, $1,$2,$3, $4::timestamp AT TIME ZONE '${TZ}', $5::timestamp AT TIME ZONE '${TZ}', $6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [resource, title || '', type, start, end, !!allDay, !!confirmed, note || '',
     JSON.stringify(fields || {}), JSON.stringify(clients || []), createdBy || null,
     bitrixItemId || null, source || 'manual']
  );
  return rows[0];
}

async function fetchByIds(client, ids) {
  if (!ids.length) return [];
  const { rows } = await client.query(
    `SELECT ${SELECT_COLS} FROM ticketsmodule_planner_events WHERE id = ANY($1::int[]) ORDER BY id`, [ids]
  );
  return rows;
}

// ── GET /api/planner/events — full list ────────────────────────────────────
router.get('/events', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${SELECT_COLS} FROM ticketsmodule_planner_events ORDER BY id`);
    res.json({ events: rows.map(rowToEvent) });
  } catch (e) {
    console.error('GET /api/planner/events error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/planner/events — create (with optional co-assignees) ────────
router.post('/events', requireAuth(), async (req, res) => {
  const { resource, title, type, start, end, allDay, confirmed, note, fields, clients, coAssignees } = req.body;
  if (!resource || !start || !end) return res.status(400).json({ error: 'resource, start, end are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const common = { title, type, start, end, allDay, confirmed, note, fields, clients, createdBy: req.user?.username };

    const primary = await insertOne(client, { ...common, resource });
    await client.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$1', [primary.id]);

    const ids = [primary.id];
    for (const name of (coAssignees || [])) {
      if (!name || name === resource) continue;
      const sib = await insertOne(client, { ...common, resource: name });
      await client.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$2', [primary.id, sib.id]);
      ids.push(sib.id);
    }

    const created = await fetchByIds(client, ids);
    await client.query('COMMIT');
    res.json({ events: created.map(rowToEvent) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('POST /api/planner/events error:', e.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── PUT /api/planner/events/:id — update (syncs co-assignee group) ────────
router.put('/events/:id', requireAuth(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { resource, title, type, start, end, allDay, confirmed, note, fields, clients, coAssignees } = req.body;
  if (!resource || !start || !end) return res.status(400).json({ error: 'resource, start, end are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query('SELECT group_id FROM ticketsmodule_planner_events WHERE id=$1', [id]);
    if (!existingRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const groupId = existingRows[0].group_id || id;

    await client.query(
      `UPDATE ticketsmodule_planner_events
       SET resource=$1, title=$2, type=$3,
           start_at=$4::timestamp AT TIME ZONE '${TZ}', end_at=$5::timestamp AT TIME ZONE '${TZ}',
           all_day=$6, confirmed=$7, note=$8, fields=$9, clients=$10, group_id=$11, updated_at=NOW()
       WHERE id=$12`,
      [resource, title || '', type, start, end, !!allDay, !!confirmed, note || '',
       JSON.stringify(fields || {}), JSON.stringify(clients || []), groupId, id]
    );

    const { rows: siblings } = await client.query(
      'SELECT id, resource FROM ticketsmodule_planner_events WHERE group_id=$1 AND id<>$2', [groupId, id]
    );
    const keep = new Set(coAssignees || []);
    const ids = [id];

    for (const sib of siblings) {
      if (keep.has(sib.resource)) {
        keep.delete(sib.resource);
        await client.query(
          `UPDATE ticketsmodule_planner_events
           SET title=$1, type=$2, start_at=$3::timestamp AT TIME ZONE '${TZ}', end_at=$4::timestamp AT TIME ZONE '${TZ}',
               all_day=$5, confirmed=$6, note=$7, fields=$8, clients=$9, updated_at=NOW()
           WHERE id=$10`,
          [title || '', type, start, end, !!allDay, !!confirmed, note || '',
           JSON.stringify(fields || {}), JSON.stringify(clients || []), sib.id]
        );
        ids.push(sib.id);
      } else {
        await client.query('DELETE FROM ticketsmodule_planner_events WHERE id=$1', [sib.id]);
      }
    }
    for (const name of keep) {
      if (!name || name === resource) continue;
      const sib = await insertOne(client, { title, type, start, end, allDay, confirmed, note, fields, clients, resource: name, createdBy: req.user?.username });
      await client.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$2', [groupId, sib.id]);
      ids.push(sib.id);
    }

    const result = await fetchByIds(client, ids);
    await client.query('COMMIT');
    res.json({ events: result.map(rowToEvent) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('PUT /api/planner/events/:id error:', e.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/planner/events/:id — removes just this one instance ───────
router.delete('/events/:id', requireAuth(), async (req, res) => {
  try {
    await pool.query('DELETE FROM ticketsmodule_planner_events WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/planner/events/:id error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Custom Data Fields API (shared, replaces localStorage pls3_df) ────────
router.get('/datafields', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ticketsmodule_planner_datafields ORDER BY sort_order, id');
    res.json({ dataFields: rows.map(r=>({id:r.id, name:r.name, type:r.type, options:r.options||[], required:r.required})) });
  } catch (e) {
    console.error('GET /api/planner/datafields error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/datafields', requireAuth(), async (req, res) => {
  const { name, type, options } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  try {
    const { rows } = await pool.query(`SELECT id FROM ticketsmodule_planner_datafields WHERE id ~ '^df[0-9]+$'`);
    const maxN = rows.reduce((m,r)=>Math.max(m, parseInt(r.id.slice(2),10)||0), 9);
    const newId = 'df' + (maxN + 1);
    const { rows: maxSort } = await pool.query('SELECT COALESCE(MAX(sort_order),0) AS m FROM ticketsmodule_planner_datafields');
    await pool.query(
      'INSERT INTO ticketsmodule_planner_datafields (id, name, type, options, sort_order) VALUES ($1,$2,$3,$4,$5)',
      [newId, name, type, JSON.stringify(options || []), maxSort[0].m + 1]
    );
    res.json({ id: newId });
  } catch (e) {
    console.error('POST /api/planner/datafields error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/datafields/:id', requireAuth(), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  try {
    await pool.query('UPDATE ticketsmodule_planner_datafields SET name=$1 WHERE id=$2', [name, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/planner/datafields/:id error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/datafields/:id', requireAuth(), async (req, res) => {
  try {
    await pool.query('DELETE FROM ticketsmodule_planner_datafields WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/planner/datafields/:id error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = { router, rowToEvent, SELECT_COLS, TZ };


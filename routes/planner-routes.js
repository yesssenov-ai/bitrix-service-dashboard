const express = require('express');
const router = express.Router();
const { pool, requireAuth, canEdit, canDelete, auditLog } = require('../auth');
const { b24 } = require('../bitrix');
const { getItem } = require('../relations');
const { getRootDealManager, getContractFromChain, fmtDateOnly, markRecentlyDeleted } = require('../bitrix-lookups');
const { notifyJobAssigned } = require('../manager-notifications');

// All start/end values from the client are naive "YYYY-MM-DDTHH:mm" strings
// (no timezone) representing local Kazakhstan wall-clock time. We must be
// explicit about that on both sides of Postgres, since a bare TIMESTAMPTZ
// write/read without this would silently assume UTC and shift every time by
// several hours.
const TZ = 'Asia/Almaty';
const crypto = require('crypto');
const { USERS } = require('../constants');

// Fingerprint of {engineerId, start, end} — used on both sides of the sync
// to tell a genuine external Bitrix change apart from Bitrix simply echoing
// back an update we ourselves just pushed.
function computeSyncHash(engineerId, start, end) {
  return crypto.createHash('sha256').update(`${engineerId}|${start}|${end}`).digest('hex').slice(0, 16);
}

// Reverse-lookup: planner resource name → Bitrix user ID, needed to push an
// engineer reassignment back to Bitrix. Prefers the live staff roster
// (bitrixUserId backfilled by the staff sync); falls back to the USERS map.
async function resolveBitrixUserId(resourceName) {
  try {
    const { rows } = await pool.query(`SELECT value FROM ticketsmodule_planner_config WHERE key='depts'`);
    const adminDepts = rows[0]?.value || [];
    for (const d of adminDepts) {
      const m = d.members.find(x => x.name === resourceName);
      if (m?.bitrixUserId) return m.bitrixUserId;
    }
  } catch (e) { /* fall through to USERS map */ }
  const found = Object.entries(USERS).find(([, name]) => name === resourceName);
  return found ? parseInt(found[0], 10) : null;
}

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

// ── GET /api/planner/events/version — дешёвый маркер изменений для поллинга ──
// Фронт тянет полный список событий только когда маркер изменился (экономит
// egress из Supabase). Объявлен ПЕРЕД /events, чтобы не перехватывался.
router.get('/events/version', requireAuth(), async (req, res) => {
  try {
    const { tableVersion } = require('../db-version');
    res.json({ v: await tableVersion('ticketsmodule_planner_events') });
  } catch (e) {
    console.error('GET /api/planner/events/version error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Командировка считается «полностью согласованной» начиная со стадии «Выдача
// командировочных» (деньги выдают после подписи главбуха). До неё — на согласовании.
const TRIP_APPROVED_STAGES = new Set(['DT1074_15:CLIENT','DT1074_15:1','DT1074_15:2','DT1074_15:3','DT1074_15:SUCCESS']);
let _tripStageCache = { map: {}, at: 0 };
function invalidateTripStageCache() { _tripStageCache.at = 0; }
// Текущие стадии командировок (1074) по их id — батчем, с кэшем ~60с, fail-open.
async function fetchTripStages(ids) {
  if (!ids.length) return {};
  if (Date.now() - _tripStageCache.at < 60e3) return _tripStageCache.map;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000));
  try {
    const r = await Promise.race([b24('crm.item.list', { entityTypeId: 1074, filter: { '@id': ids }, select: ['id', 'stageId'] }), timeout]);
    const map = {};
    for (const it of ((r && r.result && r.result.items) || [])) map[it.id] = it.stageId;
    _tripStageCache = { map, at: Date.now() };
    return map;
  } catch (e) { return _tripStageCache.map; } // не смогли — красим по последнему известному
}
// Проставляет командировкам tripApproved (полностью согласована) — Планировщик
// красит светло-/насыщенно-зелёным и автоматически перекрашивает после подписи.
async function enrichTripApproval(events) {
  const ids = [...new Set(events.filter(e => e.type === 'trip' && e.bitrixItemId).map(e => e.bitrixItemId))];
  if (!ids.length) return;
  const map = await fetchTripStages(ids);
  for (const e of events) {
    if (e.type === 'trip' && e.bitrixItemId && map[e.bitrixItemId]) {
      e.tripApproved = TRIP_APPROVED_STAGES.has(map[e.bitrixItemId]);
    }
  }
}

// ── GET /api/planner/events — full list ────────────────────────────────────
router.get('/events', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${SELECT_COLS} FROM ticketsmodule_planner_events ORDER BY id`);
    const events = rows.map(rowToEvent);
    await enrichTripApproval(events);
    res.json({ events });
  } catch (e) {
    console.error('GET /api/planner/events error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/planner/events — create (with optional co-assignees) ────────
router.post('/events', requireAuth(), async (req, res) => {
  const { resource, title, type, start, end, allDay, confirmed, note, fields, clients, coAssignees } = req.body;
  if (!resource || !start || !end) return res.status(400).json({ error: 'resource, start, end are required' });

  // Role gate: viewer — none; engineer — only events assigned to themselves;
  // admin/manager/logist/coordinator — any. The new event's owner is `resource`.
  const ownerObj = { engineer: resource, assignedById: await resolveBitrixUserId(resource) };
  if (!canEdit(req.user, ownerObj)) return res.status(403).json({ error: 'Недостаточно прав' });

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
    // Событие, созданное вручную в самом Планировщике, НЕ заводится в Bitrix —
    // оно остаётся только в ЦУП-планировщике (без bitrix_item_id → нейтральный
    // цвет). Процессные события (отпуск/встреча/командировка) создаются из своих
    // модулей раздела «Процессы» (POST /leaves, /meetings, /trips), где и пишутся
    // сразу в Bitrix и в Планировщик.
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
// ── Отпуска: смарт-процесс Bitrix 1108 «Отпуска» ──────────────────────────
// Поля (из probe): ответственный = assignedById, даты — ufCrm19_*. Воронка 23.
const LEAVE_ETID = 1108, LEAVE_CAT = 23;
const LEAVE_START = 'ufCrm19_1782732324', LEAVE_END = 'ufCrm19_1782732517';
const LEAVE_TYPE = 'ufCrm19_1782733656';      // Тип отпуска (enum)
const LEAVE_SUPERVISOR = 'ufCrm19_1782731861'; // Согласующий руководитель (employee)
const LEAVE_DAYS = 'ufCrm19_1782732922';       // Количество дней (double)
const LEAVE_PERIOD_FROM = 'ufCrm19_1782737236', LEAVE_PERIOD_TO = 'ufCrm19_1782737287'; // За период работы
const _ddmmyyyy = d => { const [y, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}.${m}.${y}`; };
const _daysBetween = (s, e) => { const a = Date.parse(s + 'T00:00:00'), b = Date.parse(e + 'T00:00:00'); return (a && b && b >= a) ? Math.round((b - a) / 864e5) + 1 : null; };
// Создать отпуск в Bitrix (1108) из подтверждённого события Планировщика и
// привязать его id к событию. extra (из fields события) — тип отпуска, согласующий,
// период работы: если заданы, садим их в соответствующие поля 1108.
async function createLeaveInBitrix(id, resource, start, end, extra) {
  const engineerId = await resolveBitrixUserId(resource);
  const s = String(start).slice(0, 10), e = String(end).slice(0, 10);
  const title = `Отпуск ${resource} (${_ddmmyyyy(s)} - ${_ddmmyyyy(e)})`;
  const x = extra || {};
  try {
    const fields = { title, categoryId: LEAVE_CAT, [LEAVE_START]: s, [LEAVE_END]: e };
    if (engineerId) fields.assignedById = engineerId;
    const days = x.leaveDays || _daysBetween(s, e);
    if (days) fields[LEAVE_DAYS] = days;
    if (x.leaveType) fields[LEAVE_TYPE] = x.leaveType;
    if (x.supervisorBid) fields[LEAVE_SUPERVISOR] = x.supervisorBid;
    if (x.periodFrom) fields[LEAVE_PERIOD_FROM] = String(x.periodFrom).slice(0, 10);
    if (x.periodTo) fields[LEAVE_PERIOD_TO] = String(x.periodTo).slice(0, 10);
    const r = await b24('crm.item.add', { entityTypeId: LEAVE_ETID, fields });
    const item = r && r.result && r.result.item;
    const bid = item && item.id;
    if (bid) await pool.query('UPDATE ticketsmodule_planner_events SET bitrix_item_id=$1 WHERE id=$2', [bid, id]);
    return bid || null;
  } catch (e) {
    console.error(`createLeaveInBitrix failed for planner event ${id}:`, e.message);
    return null;
  }
}

// ── Встречи: ВОРОНКА (категория 4) в Сделках Bitrix (entityTypeId 2) ───────
// Поля (из deal-probe): дата встречи ufCrm_1736508416174, локация ufCrm_1736508501960,
// краткое название ufCrm_1736508064357, ответственный assignedById.
const MEET_ETID = 2, MEET_CAT = 4;
const MEET_DATE = 'ufCrm_1736508416174', MEET_LOC = 'ufCrm_1736508501960', MEET_SHORT = 'ufCrm_1736508064357';
const MEET_COMMENT = 'ufCrm_1736509203015'; // Общий комментарий по встрече
// Создать встречу в Bitrix (сделка в воронке «Встречи») из подтверждённого события.
// extra (из fields события) — локация и комментарий встречи.
async function createMeetingInBitrix(id, resource, start, end, title, note, extra) {
  const engineerId = await resolveBitrixUserId(resource);
  const s = String(start).slice(0, 10);
  const name = String(title || '').trim() || `Встреча ${resource} (${_ddmmyyyy(s)})`;
  const x = extra || {};
  try {
    const fields = { title: name, categoryId: MEET_CAT, [MEET_DATE]: s, [MEET_SHORT]: name.slice(0, 250) };
    if (engineerId) fields.assignedById = engineerId;
    const loc = String(x.meetLoc || note || '').trim(); if (loc) fields[MEET_LOC] = loc.slice(0, 250);
    const cmt = String(x.meetComment || '').trim(); if (cmt) fields[MEET_COMMENT] = cmt.slice(0, 2000);
    const r = await b24('crm.item.add', { entityTypeId: MEET_ETID, fields });
    const item = r && r.result && r.result.item;
    const bid = item && item.id;
    if (bid) await pool.query('UPDATE ticketsmodule_planner_events SET bitrix_item_id=$1 WHERE id=$2', [bid, id]);
    return bid || null;
  } catch (e) {
    console.error(`createMeetingInBitrix failed for planner event ${id}:`, e.message);
    return null;
  }
}

// ── Outbound push: planner edit → Bitrix (dates + engineer only) ──────────
// Type-aware: отпуск → 1108 (ufCrm19_*), встреча → сделка 2 (ufCrm_*), иначе → 1058 (ufCrm8_*).
async function pushEventToBitrix(bitrixItemId, resource, start, end, type) {
  const engineerId = await resolveBitrixUserId(resource);
  const sDateOnly = start.slice(0, 10), eDateOnly = end.slice(0, 10);
  if (type === 'leave') {
    try {
      const fields = { [LEAVE_START]: sDateOnly, [LEAVE_END]: eDateOnly };
      if (engineerId) fields.assignedById = engineerId;
      await b24('crm.item.update', { entityTypeId: LEAVE_ETID, id: bitrixItemId, fields });
    } catch (e) {
      console.error(`Outbound push (отпуск) failed for item ${bitrixItemId}:`, e.message);
    }
    return;
  }
  if (type === 'meeting') {
    try {
      const fields = { [MEET_DATE]: sDateOnly };
      if (engineerId) fields.assignedById = engineerId;
      await b24('crm.item.update', { entityTypeId: MEET_ETID, id: bitrixItemId, fields });
    } catch (e) {
      console.error(`Outbound push (встреча) failed for item ${bitrixItemId}:`, e.message);
    }
    return;
  }
  if (!engineerId) {
    console.warn(`Outbound push: no Bitrix user ID found for "${resource}" — skipping push for item ${bitrixItemId}`);
    return;
  }
  const hash = computeSyncHash(engineerId, sDateOnly, eDateOnly);
  try {
    await b24('crm.item.update', {
      entityTypeId: 1058, id: bitrixItemId,
      fields: {
        ufCrm8_1732856367: engineerId,
        ufCrm8_1764742554715: sDateOnly,
        ufCrm8_1764742724958: eDateOnly,
      },
    });
    await pool.query('UPDATE ticketsmodule_planner_events SET bitrix_sync_hash=$1 WHERE bitrix_item_id=$2', [hash, bitrixItemId]);
  } catch (e) {
    console.error(`Outbound push to Bitrix failed for item ${bitrixItemId}:`, e.message);
  }
}

// Sends the same rich "job changed" notification the inbound webhook sends,
// but for edits that originated in the planner itself. The inbound echo that
// results from our own outbound push is deliberately NOT treated as a new
// change (see the hash check in syncPlannerEvent) — so without this, nobody
// would ever be told about a change made by dragging/editing in the planner.
async function notifyOutboundChange(bitrixItemId, resource, start, end, oldRow, changeFlags) {
  const item = await getItem(1058, bitrixItemId);
  if (!item) return;

  const engineerId = await resolveBitrixUserId(resource);
  const engineerName = resource;
  const mgr = await getRootDealManager(1058, item);
  const managerId = mgr?.managerId;
  const managerName = managerId ? (USERS[managerId] || `Пользователь #${managerId}`) : '';
  const contractLabel = await getContractFromChain(1058, item);
  const companyId = parseInt(item.companyId, 10);
  const clientName = (oldRow.clients || [])[0]?.name || '';
  const f = oldRow.fields || {};

  const parts = [];
  if (changeFlags.engineerChanged) parts.push('изменён инженер');
  if (changeFlags.datesChanged) parts.push('изменены даты работ');
  const reason = 'Обновление по заявке (из планировщика): ' + parts.join(', ');

  const sDate = new Date(start), eDate = new Date(end);
  const itemUrl = `https://crm.prolabsupport.kz/crm/type/1058/details/${bitrixItemId}/`;
  const dealUrl = mgr?.dealId ? `https://crm.prolabsupport.kz/crm/deal/details/${mgr.dealId}/` : null;

  await notifyJobAssigned({
    engineerId, managerId, itemId: bitrixItemId, title: item.title || '', reason,
    svcLabel: f.df3 || '', engineerName,
    assignDate: fmtDateOnly(new Date()),
    startDate: fmtDateOnly(sDate), endDate: fmtDateOnly(eDate),
    clientName, contractLabel, managerName, instrLabel: f.df4 || '', location: '',
    url: itemUrl, dealUrl,
  });
}

router.put('/events/:id', requireAuth(), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { resource, title, type, start, end, allDay, confirmed, note, fields, clients, coAssignees } = req.body;
  if (!resource || !start || !end) return res.status(400).json({ error: 'resource, start, end are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existingRows } = await client.query(
      `SELECT group_id, bitrix_item_id, resource, fields, clients, confirmed AS confirmed_old, type AS type_old,
        to_char(start_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS start_date_old,
        to_char(end_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS end_date_old
       FROM ticketsmodule_planner_events WHERE id=$1`, [id]
    );
    if (!existingRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Not found' }); }
    const groupId = existingRows[0].group_id || id;
    const bitrixItemId = existingRows[0].bitrix_item_id;
    const oldRow = existingRows[0];

    // Role gate: enforce against the EXISTING event's owner (engineer may only
    // edit their own; viewer none; management any).
    const ownerObj = { engineer: oldRow.resource, assignedById: await resolveBitrixUserId(oldRow.resource) };
    if (!canEdit(req.user, ownerObj)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Недостаточно прав' }); }

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
    // Обратная синхронизация ТОЛЬКО для событий, уже связанных с Bitrix (из модулей
    // Процессов или сервисных выездов 1058): правка дат/инженера в Планировщике
    // уходит в соответствующий элемент Bitrix. Ручные события Планировщика (без
    // bitrix_item_id) в Bitrix не заводятся и не пушатся — они только в ЦУП.
    if (bitrixItemId) {
      pushEventToBitrix(bitrixItemId, resource, start, end, type).catch(()=>{});
      // Уведомления о смене инженера/дат — только для сервисных выездов (1058);
      // логика notifyOutboundChange завязана на 1058, для отпуска/встречи не шлём.
      if (type !== 'leave' && type !== 'meeting') {
        const engineerChanged = oldRow.resource !== resource;
        const datesChanged = oldRow.start_date_old !== start.slice(0,10) || oldRow.end_date_old !== end.slice(0,10);
        if (engineerChanged || datesChanged) {
          notifyOutboundChange(bitrixItemId, resource, start, end, oldRow, { engineerChanged, datesChanged }).catch(e=>console.error('notifyOutboundChange error:', e.message));
        }
      }
    }
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
  // Deleting in Планировщик is limited to admin and coordinator (this is the
  // coordinator's module). Every delete is written to the audit log.
  if (!canDelete(req.user, 'PLN')) return res.status(403).json({ error: 'Недостаточно прав' });
  try {
    const { rows } = await pool.query('SELECT bitrix_item_id FROM ticketsmodule_planner_events WHERE id=$1', [req.params.id]);
    await pool.query('DELETE FROM ticketsmodule_planner_events WHERE id=$1', [req.params.id]);
    if (rows[0]?.bitrix_item_id) markRecentlyDeleted(rows[0].bitrix_item_id);
    const ip = req.headers['x-forwarded-for'] || req.ip;
    const ua = req.headers['user-agent'];
    auditLog(req.user.id, req.user.username, 'PLANNER_EVENT_DELETED', String(req.params.id),
      { bitrixItemId: rows[0]?.bitrix_item_id || null }, ip, ua).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/planner/events/:id error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Planner configuration (data fields, config blobs, staff sync) is restricted
// to admin and coordinator — this is the coordinator's module.
function requirePlannerAdmin(req, res, next) {
  if (!['admin', 'superadmin', 'coordinator'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Недостаточно прав' });
  }
  next();
}

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

router.post('/datafields', requireAuth(), requirePlannerAdmin, async (req, res) => {
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

router.put('/datafields/:id', requireAuth(), requirePlannerAdmin, async (req, res) => {
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

router.delete('/datafields/:id', requireAuth(), requirePlannerAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM ticketsmodule_planner_datafields WHERE id=$1', [req.params.id]);
    const ip = req.headers['x-forwarded-for'] || req.ip;
    const ua = req.headers['user-agent'];
    auditLog(req.user.id, req.user.username, 'PLANNER_DATAFIELD_DELETED', String(req.params.id),
      {}, ip, ua).catch(()=>{});
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /api/planner/datafields/:id error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Generic config blob API (staff roster, color palette) ─────────────────
router.get('/config/:key', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT value FROM ticketsmodule_planner_config WHERE key=$1', [req.params.key]);
    res.json({ value: rows[0]?.value ?? null });
  } catch (e) {
    console.error('GET /api/planner/config/:key error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});
router.put('/config/:key', requireAuth(), requirePlannerAdmin, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_planner_config (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
      [req.params.key, JSON.stringify(req.body.value)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/planner/config/:key error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Staff sync from Bitrix (one-directional: Bitrix → planner only) ───────
// Adds active Bitrix employees not yet in the roster; never removes or
// overwrites anything a person set up manually in the planner admin panel.
// Names/departments already in the roster are left completely alone.
const SERVICE_ACCOUNT_NAMES = new Set(['Администратор', 'Power BI']);
function normalizeName(name) { return (name || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

async function fetchAllActiveUsers() {
  const users = [];
  let start = 0;
  while (true) {
    const { result, next } = await b24('user.get', { ACTIVE: true, start });
    if (!result || !result.length) break;
    users.push(...result);
    if (next === undefined) break;
    start = next;
  }
  return users;
}

async function syncStaffFromBitrix() {
  const FALLBACK_DEPT = 'Без отдела';
  const users = await fetchAllActiveUsers();
  let deptNameById = {};
  try {
    const { result: depts } = await b24('department.get', {});
    (depts || []).forEach(d => { deptNameById[d.ID] = d.NAME; });
  } catch (e) {
    console.warn('department.get failed (missing "company structure" scope on the webhook?) — falling back to "Без отдела" for everyone:', e.message);
  }

  const { rows } = await pool.query(`SELECT value FROM ticketsmodule_planner_config WHERE key='depts'`);
  const adminDepts = rows[0]?.value || [];

  const byNormName = new Map();
  adminDepts.forEach(d => d.members.forEach(m => byNormName.set(normalizeName(m.name), m)));
  const findDeptOf = (member) => adminDepts.find(d => d.members.includes(member));
  const findOrCreateDept = (name) => {
    let dept = adminDepts.find(d => normalizeName(d.name) === normalizeName(name));
    if (!dept) { dept = { id: 'dept_'+Date.now()+'_'+adminDepts.length, name, color: '#8a8784', members: [] }; adminDepts.push(dept); }
    return dept;
  };

  let added = 0, idBackfilled = 0, reassigned = 0;
  let nextStaffNum = Date.now() % 100000; // avoid collisions with existing 'staffN' ids

  for (const u of users) {
    const fullName = `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim();
    if (!fullName || SERVICE_ACCOUNT_NAMES.has(fullName)) continue;
    const bitrixDeptId = (u.UF_DEPARTMENT || [])[0];
    const bitrixDeptName = deptNameById[bitrixDeptId] || FALLBACK_DEPT;

    const existing = byNormName.get(normalizeName(fullName));
    if (existing) {
      if (!existing.bitrixUserId) { existing.bitrixUserId = parseInt(u.ID, 10); idBackfilled++; }
      // Only reassign when we actually resolved a real department name —
      // never blindly move someone into the fallback bucket just because
      // department.get failed or this person's dept lookup came up empty.
      if (bitrixDeptName !== FALLBACK_DEPT) {
        const currentDept = findDeptOf(existing);
        if (currentDept && normalizeName(currentDept.name) !== normalizeName(bitrixDeptName)) {
          currentDept.members = currentDept.members.filter(m => m !== existing);
          findOrCreateDept(bitrixDeptName).members.push(existing);
          reassigned++;
        }
      }
      continue;
    }

    const dept = findOrCreateDept(bitrixDeptName);
    const newMember = {
      id: 'staff'+(nextStaffNum++), name: fullName, bitrixUserId: parseInt(u.ID, 10),
      role: 'member', perms: { view: true, edit: false, admin: false },
    };
    dept.members.push(newMember);
    byNormName.set(normalizeName(fullName), newMember);
    added++;
  }

  // Clean up any department left empty by the reassignment above
  for (let i = adminDepts.length - 1; i >= 0; i--) {
    if (adminDepts[i].members.length === 0) adminDepts.splice(i, 1);
  }

  await pool.query(
    `INSERT INTO ticketsmodule_planner_config (key, value, updated_at) VALUES ('depts',$1,NOW())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=NOW()`,
    [JSON.stringify(adminDepts)]
  );
  return { added, idBackfilled, reassigned, totalBitrixUsers: users.length };
}

router.post('/sync-staff', requireAuth(), requirePlannerAdmin, async (req, res) => {
  try {
    const result = await syncStaffFromBitrix();
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('POST /api/planner/sync-staff error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Personal per-user preferences (e.g. which departments this person hides) ─
router.get('/my-prefs/:key', requireAuth(), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM ticketsmodule_user_prefs WHERE user_id=$1 AND key=$2', [req.user.id, req.params.key]
    );
    res.json({ value: rows[0]?.value ?? null });
  } catch (e) {
    console.error('GET /api/planner/my-prefs/:key error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});
router.put('/my-prefs/:key', requireAuth(), async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO ticketsmodule_user_prefs (user_id, key, value, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value=$3, updated_at=NOW()`,
      [req.user.id, req.params.key, JSON.stringify(req.body.value)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /api/planner/my-prefs/:key error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/planner/notifications/:bitrixItemId — notification history for one Bitrix item, shown in the event's "Уведомления" tab
router.get('/notifications/:bitrixItemId', requireAuth(), async (req, res) => {
  try {
    const itemId = parseInt(req.params.bitrixItemId, 10);
    if (!itemId) return res.status(400).json({ error: 'Неверный ID' });
    const { rows } = await pool.query(
      `SELECT sent_at, reason, channel, recipient_label, success, error
       FROM ticketsmodule_notification_log WHERE bitrix_item_id=$1 ORDER BY sent_at DESC`,
      [itemId]
    );
    res.json({ logs: rows });
  } catch (e) {
    console.error('GET /api/planner/notifications/:bitrixItemId error:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Discovery (read-only): структура смарт-процессов для маппинга полей ──────
// Нужен, чтобы точно понять, в какие поля садить сотрудника/даты/заголовок при
// создании Командировки (1058) / Отпуска / Встречи из Планировщика. Ничего не
// пишет в Bitrix — только читает type.list / item.fields / status.list / sample.
async function probeProcess(reName) {
  try {
    const tr = await b24('crm.type.list', {});
    const types = (tr && tr.result && tr.result.types) || [];
    const t = types.find(x => reName.test(x.title || ''));
    if (!t) return { found: false, searched: reName.source, allTypes: types.map(x => ({ id: x.entityTypeId, title: x.title })) };
    const etid = t.entityTypeId;
    let fields = [];
    try {
      const fr = await b24('crm.item.fields', { entityTypeId: etid });
      const f = (fr && fr.result && fr.result.fields) || {};
      fields = Object.entries(f).map(([code, m]) => ({ code, title: (m && m.title) || '', type: (m && m.type) || '', required: !!(m && m.isRequired) }));
    } catch (e) { fields = [{ error: e.message }]; }
    let categories = [];
    try {
      const cr = await b24('crm.category.list', { entityTypeId: etid });
      categories = ((cr && cr.result && cr.result.categories) || []).map(c => ({ id: c.id, name: c.name }));
    } catch (e) {}
    let stages = [];
    try {
      let start = 0, g = 0;
      while (g++ < 10) {
        const sr = await b24('crm.status.list', { start });
        for (const s of (sr && sr.result) || []) {
          if (String(s.ENTITY_ID || '').indexOf('DYNAMIC_' + etid + '_') === 0) stages.push({ id: s.STATUS_ID, name: s.NAME });
        }
        const n = sr && sr.next; if (n === undefined || n === null) break; start = n;
      }
    } catch (e) {}
    let sample = null;
    try {
      const ir = await b24('crm.item.list', { entityTypeId: etid, order: { id: 'desc' }, start: 0 });
      sample = ((ir && ir.result && ir.result.items) || [])[0] || null;
    } catch (e) {}
    return { found: true, entityTypeId: etid, title: t.title, categories, stages, fields, sample };
  } catch (e) { return { found: false, error: e.message, searched: reName.source }; }
}
router.get('/bitrix-probe', requireAuth(), requirePlannerAdmin, async (req, res) => {
  try {
    res.json({
      trip: await probeProcess(/командиров/i),
      leave: await probeProcess(/отпуск/i),
      meeting: await probeProcess(/встреч/i),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Встречи — это ВОРОНКА (категория) в Сделках (entityTypeId 2), не смарт-процесс.
// Этот probe показывает воронки сделок, поля сделок и пример сделки (по ?id=),
// чтобы понять categoryId воронки «Встречи» и в какие поля садить при создании.
router.get('/deal-probe', requireAuth(), requirePlannerAdmin, async (req, res) => {
  try {
    const id = parseInt(req.query.id, 10) || null;
    const out = {};
    try {
      const cr = await b24('crm.category.list', { entityTypeId: 2 });
      out.categories = ((cr && cr.result && cr.result.categories) || []).map(c => ({ id: c.id, name: c.name }));
    } catch (e) { out.categoriesError = e.message; }
    try {
      const fr = await b24('crm.item.fields', { entityTypeId: 2 });
      const f = (fr && fr.result && fr.result.fields) || {};
      out.fields = Object.entries(f).map(([code, m]) => ({ code, title: (m && m.title) || '', type: (m && m.type) || '', required: !!(m && m.isRequired) }));
    } catch (e) { out.fieldsError = e.message; }
    if (id) {
      try { const ir = await b24('crm.item.get', { entityTypeId: 2, id }); out.sample = (ir && ir.result && ir.result.item) || null; }
      catch (e) { out.sampleError = e.message; }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Справочники для формы Отпуска (модуль Отпусков) ───────────────────────
// Типы отпуска (enum из процесса 1108) + список сотрудников (для «согласующего»).
router.get('/leave-meta', requireAuth(), async (req, res) => {
  try {
    let leaveTypes = [];
    try {
      const fr = await b24('crm.item.fields', { entityTypeId: LEAVE_ETID });
      const f = (fr && fr.result && fr.result.fields) || {};
      const tf = f[LEAVE_TYPE] || {};
      leaveTypes = (tf.items || []).map(i => ({ id: i.ID != null ? i.ID : i.id, name: i.VALUE != null ? i.VALUE : i.value }));
    } catch (e) { /* enum недоступен — форма покажет без типов */ }
    let staff = [];
    try {
      const r = await pool.query(
        "SELECT bitrix_user_id AS bid, name FROM ticketsmodule_staff_ref WHERE bitrix_user_id IS NOT NULL AND (active IS NULL OR active = TRUE) ORDER BY name");
      staff = r.rows;
    } catch (e) {}
    res.json({ leaveTypes, staff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Карточный модуль «Отпуска» (раздел «Процессы») ────────────────────────
// Данные живут в Bitrix (смарт-процесс 1108); карточка читает их оттуда, связка
// с Планировщиком — по bitrix_item_id. Стадии процесса:
const LEAVE_STAGES = [
  { id: 'DT1108_23:NEW', name: 'Заявка на отпуск' },
  { id: 'DT1108_23:PREPARATION', name: 'Согласование' },
  { id: 'DT1108_23:CLIENT', name: 'Издание приказа и выплаты' },
  { id: 'DT1108_23:UC_0FQVY5', name: 'Отпуск' },
  { id: 'DT1108_23:UC_KWS3UL', name: 'Отпуск завершён' },
  { id: 'DT1108_23:SUCCESS', name: 'Успех' },
  { id: 'DT1108_23:FAIL', name: 'Провал' },
];
const LEAVE_STAGE_NAME = Object.fromEntries(LEAVE_STAGES.map(s => [s.id, s.name]));
const _bxDate = d => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(d || '')); return m ? m[1] : null; };
function mapLeaveItem(it, plannerId) {
  return {
    id: it.id, title: it.title, assignedById: it.assignedById || null,
    stageId: it.stageId, stage: LEAVE_STAGE_NAME[it.stageId] || it.stageId,
    start: _bxDate(it[LEAVE_START]), end: _bxDate(it[LEAVE_END]),
    typeId: it[LEAVE_TYPE] || null, days: it[LEAVE_DAYS] || null,
    supervisorBid: it[LEAVE_SUPERVISOR] || null, plannerId: plannerId || null,
  };
}
// Список отпусков (из 1108) + связка с событиями Планировщика.
router.get('/leaves', requireAuth(), async (req, res) => {
  try {
    let items = [];
    try {
      const r = await b24('crm.item.list', { entityTypeId: LEAVE_ETID, order: { id: 'desc' }, select: ['*', 'uf_*'] });
      items = (r && r.result && r.result.items) || [];
    } catch (e) { return res.status(502).json({ error: 'Bitrix недоступен: ' + e.message }); }
    const ids = items.map(i => i.id).filter(Boolean);
    const links = {};
    if (ids.length) {
      try {
        const lr = await pool.query("SELECT bitrix_item_id, id FROM ticketsmodule_planner_events WHERE type='leave' AND bitrix_item_id = ANY($1::int[])", [ids]);
        lr.rows.forEach(x => { links[x.bitrix_item_id] = x.id; });
      } catch (e) {}
    }
    res.json({ items: items.map(i => mapLeaveItem(i, links[i.id])), stages: LEAVE_STAGES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Деталь одного отпуска.
router.get('/leaves/:id(\\d+)', requireAuth(), async (req, res) => {
  try {
    const r = await b24('crm.item.get', { entityTypeId: LEAVE_ETID, id: parseInt(req.params.id, 10) });
    const it = r && r.result && r.result.item;
    if (!it) return res.status(404).json({ error: 'Не найдено' });
    let plannerId = null;
    try { const lr = await pool.query('SELECT id FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 LIMIT 1', [it.id]); if (lr.rows.length) plannerId = lr.rows[0].id; } catch (e) {}
    res.json({ item: mapLeaveItem(it, plannerId), stages: LEAVE_STAGES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Движение по стадии (обновляет Bitrix; Планировщик подхватит дату при правках).
router.post('/leaves/:id(\\d+)/stage', requireAuth(), express.json(), async (req, res) => {
  try {
    const stageId = String((req.body || {}).stageId || '');
    if (!LEAVE_STAGE_NAME[stageId]) return res.status(400).json({ error: 'Неверная стадия' });
    await b24('crm.item.update', { entityTypeId: LEAVE_ETID, id: parseInt(req.params.id, 10), fields: { stageId } });
    res.json({ ok: true, stageId, stage: LEAVE_STAGE_NAME[stageId] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Создание отпуска из карточки: заводим в Bitrix (1108, стадия «Заявка») И блок в
// Планировщике (type=leave, подтверждён, связан по bitrix_item_id) — «садится» в план.
router.post('/leaves', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const resource = String(b.resource || '').trim();
    const start = String(b.start || '').slice(0, 10);
    const end = String(b.end || start).slice(0, 10);
    if (!resource || !start) return res.status(400).json({ error: 'Нужны сотрудник и дата начала' });
    const engineerId = await resolveBitrixUserId(resource);
    const days = _daysBetween(start, end);
    const title = `Отпуск ${resource} (${_ddmmyyyy(start)} - ${_ddmmyyyy(end)})`;
    const fields = { title, categoryId: LEAVE_CAT, [LEAVE_START]: start, [LEAVE_END]: end };
    if (engineerId) fields.assignedById = engineerId;
    if (days) fields[LEAVE_DAYS] = days;
    if (b.leaveType) fields[LEAVE_TYPE] = b.leaveType;
    if (b.supervisorBid) fields[LEAVE_SUPERVISOR] = b.supervisorBid;
    let bid = null;
    try { const r = await b24('crm.item.add', { entityTypeId: LEAVE_ETID, fields }); bid = (r && r.result && r.result.item && r.result.item.id) || null; }
    catch (e) { return res.status(502).json({ error: 'Bitrix: ' + e.message }); }
    try {
      const evFields = JSON.stringify({ leaveType: b.leaveType || null, supervisorBid: b.supervisorBid || null, leaveDays: days || null });
      const ev = await pool.query(
        `INSERT INTO ticketsmodule_planner_events (group_id, resource, title, type, start_at, end_at, all_day, confirmed, fields, bitrix_item_id, source, created_by)
         VALUES (0,$1,$2,'leave',$3::timestamp AT TIME ZONE '${TZ}',$4::timestamp AT TIME ZONE '${TZ}',true,true,$5,$6,'manual',$7) RETURNING id`,
        [resource, title, start + 'T09:00', end + 'T18:00', evFields, bid, (req.user && req.user.username) || null]);
      await pool.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$1', [ev.rows[0].id]);
    } catch (e) { console.error('leave card → planner block:', e.message); }
    res.json({ ok: true, id: bid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Карточный модуль «Встречи» (раздел «Процессы») ────────────────────────
// Данные — сделки Bitrix в воронке 4 «Встречи»; стадии тянем из Bitrix (кэш 1ч).
let _meetStages = null, _meetStagesAt = 0;
async function getMeetStages() {
  if (_meetStages && Date.now() - _meetStagesAt < 3600e3) return _meetStages;
  try {
    const r = await b24('crm.status.list', { filter: { ENTITY_ID: 'DEAL_STAGE_' + MEET_CAT }, order: { SORT: 'ASC' } });
    const rows = (r && r.result) || [];
    if (rows.length) { _meetStages = rows.map(s => ({ id: s.STATUS_ID, name: s.NAME, sem: s.SEMANTICS })); _meetStagesAt = Date.now(); }
  } catch (e) { /* оставим прежний кэш */ }
  return _meetStages || [];
}
function mapMeetItem(it, plannerId, stageName) {
  return {
    id: it.id, title: it.title, short: it[MEET_SHORT] || '', assignedById: it.assignedById || null,
    stageId: it.stageId, stage: stageName || it.stageId, sem: null,
    date: _bxDate(it[MEET_DATE]), loc: it[MEET_LOC] || '', comment: it[MEET_COMMENT] || '',
    companyId: it.companyId || null, plannerId: plannerId || null,
  };
}
router.get('/meetings', requireAuth(), async (req, res) => {
  try {
    const stages = await getMeetStages(); const sn = Object.fromEntries(stages.map(s => [s.id, s.name]));
    let items = [];
    try { const r = await b24('crm.item.list', { entityTypeId: MEET_ETID, filter: { categoryId: MEET_CAT }, order: { id: 'desc' }, select: ['*', 'uf_*'] }); items = (r && r.result && r.result.items) || []; }
    catch (e) { return res.status(502).json({ error: 'Bitrix недоступен: ' + e.message }); }
    const ids = items.map(i => i.id).filter(Boolean); const links = {};
    if (ids.length) { try { const lr = await pool.query("SELECT bitrix_item_id, id FROM ticketsmodule_planner_events WHERE type='meeting' AND bitrix_item_id = ANY($1::int[])", [ids]); lr.rows.forEach(x => { links[x.bitrix_item_id] = x.id; }); } catch (e) {} }
    res.json({ items: items.map(i => mapMeetItem(i, links[i.id], sn[i.stageId])), stages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/meetings/:id(\\d+)', requireAuth(), async (req, res) => {
  try {
    const stages = await getMeetStages(); const sn = Object.fromEntries(stages.map(s => [s.id, s.name]));
    const r = await b24('crm.item.get', { entityTypeId: MEET_ETID, id: parseInt(req.params.id, 10) });
    const it = r && r.result && r.result.item;
    if (!it) return res.status(404).json({ error: 'Не найдено' });
    let plannerId = null;
    try { const lr = await pool.query('SELECT id FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 LIMIT 1', [it.id]); if (lr.rows.length) plannerId = lr.rows[0].id; } catch (e) {}
    res.json({ item: mapMeetItem(it, plannerId, sn[it.stageId]), stages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/meetings/:id(\\d+)/stage', requireAuth(), express.json(), async (req, res) => {
  try {
    const stageId = String((req.body || {}).stageId || '');
    const stages = await getMeetStages(); const st = stages.find(s => s.id === stageId);
    if (!st) return res.status(400).json({ error: 'Неверная стадия' });
    await b24('crm.item.update', { entityTypeId: MEET_ETID, id: parseInt(req.params.id, 10), fields: { stageId } });
    res.json({ ok: true, stageId, stage: st.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Создание встречи из карточки: сделка в воронке 4 + блок в Планировщике.
router.post('/meetings', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const resource = String(b.resource || '').trim();
    const date = String(b.date || '').slice(0, 10);
    const name = String(b.title || '').trim();
    if (!name || !date) return res.status(400).json({ error: 'Нужны тема и дата встречи' });
    const engineerId = resource ? await resolveBitrixUserId(resource) : null;
    const fields = { title: name, categoryId: MEET_CAT, [MEET_DATE]: date, [MEET_SHORT]: name.slice(0, 250) };
    if (engineerId) fields.assignedById = engineerId;
    if (b.loc) fields[MEET_LOC] = String(b.loc).slice(0, 250);
    if (b.comment) fields[MEET_COMMENT] = String(b.comment).slice(0, 2000);
    let bid = null;
    try { const r = await b24('crm.item.add', { entityTypeId: MEET_ETID, fields }); bid = (r && r.result && r.result.item && r.result.item.id) || null; }
    catch (e) { return res.status(502).json({ error: 'Bitrix: ' + e.message }); }
    try {
      const evFields = JSON.stringify({ meetLoc: b.loc || null, meetComment: b.comment || null });
      const ev = await pool.query(
        `INSERT INTO ticketsmodule_planner_events (group_id, resource, title, type, start_at, end_at, all_day, confirmed, fields, bitrix_item_id, source, created_by)
         VALUES (0,$1,$2,'meeting',$3::timestamp AT TIME ZONE '${TZ}',$4::timestamp AT TIME ZONE '${TZ}',false,true,$5,$6,'manual',$7) RETURNING id`,
        [resource || name, name, date + 'T10:00', date + 'T11:00', evFields, bid, (req.user && req.user.username) || null]);
      await pool.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$1', [ev.rows[0].id]);
    } catch (e) { console.error('meeting card → planner block:', e.message); }
    res.json({ ok: true, id: bid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Карточный модуль «Командировки» (раздел «Процессы») ───────────────────
// Данные — смарт-процесс Bitrix 1074 «Заявка на командировку», воронка 15.
const TRIP_ETID = 1074, TRIP_CAT = 15;
const TRIP_START = 'ufCrm12_1732867277610', TRIP_END = 'ufCrm12_1732867286706';
const TRIP_DEST = 'ufCrm12_1732867225794', TRIP_PURPOSE = 'ufCrm12_1732867109113';
const TRIP_ROUTE = 'ufCrm12_1732867267601', TRIP_NUMBER = 'ufCrm12_1763384122385';
// Поля цикла согласования (подписи), приказа и финансов — для согласования в ЦУП.
// Роботы Bitrix двигают стадии по заполнению ДАТ подписи; ЦУП пишет дату+коммент.
const TRIP_SUP = 'ufCrm12_1732866961'; // Согласующий руководитель (employee)
const TRIP_SIGN = {
  ruk:  { date: 'ufCrm12_1732867855067', comment: 'ufCrm12_1732867869290', label: 'Руководитель' },
  buh:  { date: 'ufCrm12_1732867892083', comment: 'ufCrm12_1732867907794', label: 'Бухгалтер' },
  glav: { date: 'ufCrm12_1763458463',    comment: 'ufCrm12_1763377618706', label: 'Главбух' },
};
const TRIP_SIGN_ORDER = ['ruk', 'buh', 'glav'];
const TRIP_ORDER = { num: 'ufCrm12_1732867927514', date: 'ufCrm12_1732867941708', file: 'ufCrm12_1732867952932' };
const TRIP_FIN = { perdiemKz: 'ufCrm12_1732867370481', perdiemFr: 'ufCrm12_1776932442741', lodging: 'ufCrm12_1732867384914', visa: 'ufCrm12_1781502339', travel: 'ufCrm12_1781502500', total: 'ufCrm12_1763358920704', docsProzh: 'ufCrm12_1732868047443', docsProezd: 'ufCrm12_1732868055962', avr: 'ufCrm12_1763119612096' };
const TRIP_SVC_FIELD = 'ufCrm12_1732867415'; // Тип оказываемых услуг (iblock 25)
const TRIP_CHECK = [
  { code: 'ufCrm12_1732867489825', label: 'Ознакомился с договором и спецификациями' },
  { code: 'ufCrm12_1732867520626', label: 'Согласованы прединсталляционные требования' },
  { code: 'ufCrm12_1732867560506', label: 'Прибор и допоборудование упаковано' },
  { code: 'ufCrm12_1732867591490', label: 'Наличие спецодежды' },
  { code: 'ufCrm12_1732867623473', label: 'Набор инструментов инженера' },
  { code: 'ufCrm12_1732867655227', label: 'Наличие расходных материалов' },
  { code: 'ufCrm12_1732867679634', label: 'Запасные части и расходники взяты' },
  { code: 'ufCrm12_1732867717083', label: 'Наличие технической документации' },
  { code: 'ufCrm12_1732867748345', label: 'Наличие необходимых удостоверений' },
  { code: 'ufCrm12_1732867774898', label: 'WI-FI адаптер и драйверы' },
  { code: 'ufCrm12_1732867801947', label: 'Пропуск согласован (e-mail)' },
  { code: 'ufCrm12_1732867828242', label: 'Финансовые документы' },
];
const TRIP_CHECK_CODES = TRIP_CHECK.map(c => c.code);
const TRIP_CLOSE = { acceptDate: 'ufCrm12_1732868111101', reworkReason: 'ufCrm12_1732868125114' };
const TRIP_CHANGE = { reason: 'ufCrm12_1732867979962', parent: 'ufCrm12_1732867999' };
const _empId = v => Array.isArray(v) ? (v[0] || null) : (v || null);
const _nz = v => (v === null || v === undefined || v === '') ? '' : v;
async function getTripApprovers() {
  try { const { rows } = await pool.query("SELECT value FROM ticketsmodule_planner_config WHERE key='trip_approvers'"); return rows[0]?.value || {}; }
  catch (e) { return {}; }
}
const TRIP_STAGES = [
  { id: 'DT1074_15:NEW', name: 'Запрос' },
  { id: 'DT1074_15:PREPARATION', name: 'Согласование' },
  { id: 'DT1074_15:CLIENT', name: 'Выдача командировочных' },
  { id: 'DT1074_15:1', name: 'В командировке' },
  { id: 'DT1074_15:2', name: 'Отчёт' },
  { id: 'DT1074_15:3', name: 'Закрытие' },
  { id: 'DT1074_15:SUCCESS', name: 'Завершена' },
  { id: 'DT1074_15:FAIL', name: 'Не состоялась' },
];
const TRIP_STAGE_NAME = Object.fromEntries(TRIP_STAGES.map(s => [s.id, s.name]));
const _tv = v => Array.isArray(v) ? (v[0] || '') : (v || '');
function mapTripItem(it, plannerId) {
  return {
    id: it.id, title: it.title, assignedById: it.assignedById || null,
    stageId: it.stageId, stage: TRIP_STAGE_NAME[it.stageId] || it.stageId,
    start: _bxDate(it[TRIP_START]), end: _bxDate(it[TRIP_END]),
    dest: _tv(it[TRIP_DEST]), purpose: _tv(it[TRIP_PURPOSE]), route: _tv(it[TRIP_ROUTE]),
    number: it[TRIP_NUMBER] || '', plannerId: plannerId || null,
  };
}
router.get('/trips', requireAuth(), async (req, res) => {
  try {
    let items = [];
    try { const r = await b24('crm.item.list', { entityTypeId: TRIP_ETID, filter: { categoryId: TRIP_CAT }, order: { id: 'desc' }, select: ['*', 'uf_*'] }); items = (r && r.result && r.result.items) || []; }
    catch (e) { return res.status(502).json({ error: 'Bitrix недоступен: ' + e.message }); }
    const ids = items.map(i => i.id).filter(Boolean); const links = {};
    if (ids.length) { try { const lr = await pool.query("SELECT bitrix_item_id, id FROM ticketsmodule_planner_events WHERE type='trip' AND bitrix_item_id = ANY($1::int[])", [ids]); lr.rows.forEach(x => { links[x.bitrix_item_id] = x.id; }); } catch (e) {} }
    res.json({ items: items.map(i => mapTripItem(i, links[i.id])), stages: TRIP_STAGES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function _fileList(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter(Boolean).map(f => (typeof f === 'object')
    ? { id: f.id || f.ID || null, name: f.name || f.NAME || 'файл', url: f.urlMachine || f.url || f.downloadUrl || '' }
    : { id: f, name: 'файл', url: '' });
}
router.get('/trips/:id(\\d+)', requireAuth(), async (req, res) => {
  try {
    const r = await b24('crm.item.get', { entityTypeId: TRIP_ETID, id: parseInt(req.params.id, 10) });
    const it = r && r.result && r.result.item;
    if (!it) return res.status(404).json({ error: 'Не найдено' });
    let plannerId = null, extra = [], tripSign = {};
    try {
      const lr = await pool.query('SELECT id, fields FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 LIMIT 1', [it.id]);
      if (lr.rows.length) { plannerId = lr.rows[0].id; const f = lr.rows[0].fields || {}; extra = Array.isArray(f.tripExtra) ? f.tripExtra : []; tripSign = f.tripSign || {}; }
    } catch (e) {}
    const cfg = await getTripApprovers();
    const sign = k => ({ date: _nz(it[TRIP_SIGN[k].date]) || null, comment: it[TRIP_SIGN[k].comment] || '', status: (tripSign[k] && tripSign[k].decision) || (_nz(it[TRIP_SIGN[k].date]) ? 'approve' : null), by: tripSign[k] && tripSign[k].by || null });
    let assignedDept = '';
    try { if (it.assignedById) { const dr = await pool.query('SELECT department FROM ticketsmodule_staff_ref WHERE bitrix_user_id=$1 LIMIT 1', [it.assignedById]); if (dr.rows.length) assignedDept = dr.rows[0].department || ''; } } catch (e) {}
    const checklist = {}; TRIP_CHECK_CODES.forEach(c => { checklist[c] = _nz(it[c]) || null; });
    const detail = Object.assign(mapTripItem(it, plannerId), {
      supervisorBid: _empId(it[TRIP_SUP]),
      createdBy: it.createdBy || null,
      assignedDept,
      ap: { ruk: sign('ruk'), buh: sign('buh'), glav: sign('glav') },
      extra,
      order: { num: it[TRIP_ORDER.num] || '', date: _bxDate(it[TRIP_ORDER.date]), files: _fileList(it[TRIP_ORDER.file]) },
      fin: { perdiemKz: _nz(it[TRIP_FIN.perdiemKz]), perdiemFr: _nz(it[TRIP_FIN.perdiemFr]), lodging: _nz(it[TRIP_FIN.lodging]), visa: _nz(it[TRIP_FIN.visa]), travel: _nz(it[TRIP_FIN.travel]), total: _nz(it[TRIP_FIN.total]) },
      checklist, serviceTypeId: (Array.isArray(it[TRIP_SVC_FIELD]) ? it[TRIP_SVC_FIELD][0] : it[TRIP_SVC_FIELD]) || null,
      closing: { acceptDate: _nz(it[TRIP_CLOSE.acceptDate]) || null, reworkReason: it[TRIP_CLOSE.reworkReason] || '' },
      files: { orderFile: _fileList(it[TRIP_ORDER.file]), avr: _fileList(it[TRIP_FIN.avr]), docsProzh: _fileList(it[TRIP_FIN.docsProzh]), docsProezd: _fileList(it[TRIP_FIN.docsProezd]) },
    });
    res.json({ item: detail, stages: TRIP_STAGES, approvers: cfg, meBid: req.user.bitrix_user_id || null, meAdmin: ['admin', 'superadmin', 'coordinator'].includes(req.user.role) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/trips/:id(\\d+)/stage', requireAuth(), express.json(), async (req, res) => {
  try {
    const stageId = String((req.body || {}).stageId || '');
    if (!TRIP_STAGE_NAME[stageId]) return res.status(400).json({ error: 'Неверная стадия' });
    await b24('crm.item.update', { entityTypeId: TRIP_ETID, id: parseInt(req.params.id, 10), fields: { stageId } });
    invalidateTripStageCache();
    res.json({ ok: true, stageId, stage: TRIP_STAGE_NAME[stageId] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function _canFinance(req, cfg) {
  if (['admin', 'superadmin', 'coordinator'].includes(req.user.role)) return true;
  const me = String(req.user.bitrix_user_id);
  return me === String(cfg.buh) || me === String(cfg.glav);
}
// Согласование шага цепочки: руководитель → бухгалтер → главбух (+ доп. согласующие).
// Пишет в Bitrix дату/комментарий (роботы двигают стадию), а точный статус шага
// (approve/reject/rework + кто/когда) хранит в ЦУП (fields события).
router.post('/trips/:id(\\d+)/approve', requireAuth(), express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const step = String(b.step || '');
    const decision = ['approve', 'reject', 'rework'].includes(b.decision) ? b.decision : 'approve';
    const comment = String(b.comment || '').slice(0, 2000);
    const extraBid = b.bid != null ? String(b.bid) : null;
    const meBid = req.user.bitrix_user_id;
    const admin = ['admin', 'superadmin', 'coordinator'].includes(req.user.role);
    const gr = await b24('crm.item.get', { entityTypeId: TRIP_ETID, id });
    const it = gr && gr.result && gr.result.item;
    if (!it) return res.status(404).json({ error: 'Не найдено' });
    const cfg = await getTripApprovers();
    let allowed = admin;
    if (step === 'ruk') allowed = allowed || String(meBid) === String(_empId(it[TRIP_SUP]));
    else if (step === 'buh') allowed = allowed || String(meBid) === String(cfg.buh);
    else if (step === 'glav') allowed = allowed || String(meBid) === String(cfg.glav);
    else if (step === 'extra') allowed = allowed || String(meBid) === String(extraBid);
    else return res.status(400).json({ error: 'Неверный шаг' });
    if (!allowed) return res.status(403).json({ error: 'Этот шаг согласует другой сотрудник' });
    if (step !== 'extra') {
      const F = TRIP_SIGN[step]; const fields = {};
      if (decision === 'approve') { fields[F.date] = new Date().toISOString(); if (comment) fields[F.comment] = comment; }
      else { fields[F.comment] = comment || (decision === 'reject' ? 'Отклонено' : 'Возвращено на доработку'); }
      try { await b24('crm.item.update', { entityTypeId: TRIP_ETID, id, fields }); }
      catch (e) { return res.status(502).json({ error: 'Bitrix: ' + e.message }); }
      invalidateTripStageCache();
    }
    try {
      const lr = await pool.query('SELECT id, fields FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 LIMIT 1', [it.id]);
      if (lr.rows.length) {
        const f = lr.rows[0].fields || {};
        if (step === 'extra') {
          const ex = Array.isArray(f.tripExtra) ? f.tripExtra : [];
          const i = ex.findIndex(x => String(x.bid) === extraBid);
          if (i >= 0) ex[i] = Object.assign({}, ex[i], { decision, comment, at: new Date().toISOString() });
          f.tripExtra = ex;
        } else {
          const ts = f.tripSign || {}; ts[step] = { decision, by: meBid, comment, at: new Date().toISOString() }; f.tripSign = ts;
        }
        await pool.query('UPDATE ticketsmodule_planner_events SET fields=$1 WHERE id=$2', [JSON.stringify(f), lr.rows[0].id]);
      }
    } catch (e) { console.error('trip approve → event fields:', e.message); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Список доп. согласующих (ЦУП-сторона, в полях события). Инициатор добавляет/убирает.
router.post('/trips/:id(\\d+)/approvers', requireAuth(), express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const list = Array.isArray(req.body.extra) ? req.body.extra : [];
    const clean = list.map(x => ({ bid: String(x.bid), name: String(x.name || ''), decision: x.decision || null, comment: x.comment || '', at: x.at || null })).filter(x => x.bid && x.bid !== 'null');
    const lr = await pool.query('SELECT id, fields FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 LIMIT 1', [id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Событие планировщика не найдено' });
    const f = lr.rows[0].fields || {};
    const prev = Array.isArray(f.tripExtra) ? f.tripExtra : [];
    for (const c of clean) { const p = prev.find(x => String(x.bid) === c.bid); if (p) { c.decision = p.decision; c.comment = p.comment; c.at = p.at; } }
    f.tripExtra = clean;
    await pool.query('UPDATE ticketsmodule_planner_events SET fields=$1 WHERE id=$2', [JSON.stringify(f), lr.rows[0].id]);
    res.json({ ok: true, extra: clean });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Приказ (номер/дата) и финансы (числа) — пишем в Bitrix. Файлы — в проходе B.
router.post('/trips/:id(\\d+)/order', requireAuth(), express.json(), async (req, res) => {
  try {
    const cfg = await getTripApprovers();
    if (!_canFinance(req, cfg)) return res.status(403).json({ error: 'Недостаточно прав' });
    const id = parseInt(req.params.id, 10); const b = req.body || {}; const fields = {};
    if (b.num != null) fields[TRIP_ORDER.num] = String(b.num).slice(0, 100);
    if (b.date) fields[TRIP_ORDER.date] = String(b.date).slice(0, 10);
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Нечего сохранять' });
    await b24('crm.item.update', { entityTypeId: TRIP_ETID, id, fields });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'Bitrix: ' + e.message }); }
});
router.post('/trips/:id(\\d+)/finance', requireAuth(), express.json(), async (req, res) => {
  try {
    const cfg = await getTripApprovers();
    if (!_canFinance(req, cfg)) return res.status(403).json({ error: 'Недостаточно прав' });
    const id = parseInt(req.params.id, 10); const b = req.body || {}; const fields = {};
    const setNum = (k, code) => { if (b[k] != null && b[k] !== '') fields[code] = Number(b[k]) || 0; };
    setNum('perdiemKz', TRIP_FIN.perdiemKz); setNum('lodging', TRIP_FIN.lodging); setNum('visa', TRIP_FIN.visa); setNum('travel', TRIP_FIN.travel);
    if (b.perdiemFr != null) fields[TRIP_FIN.perdiemFr] = String(b.perdiemFr);
    if (b.total != null) fields[TRIP_FIN.total] = String(b.total);
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Нечего сохранять' });
    await b24('crm.item.update', { entityTypeId: TRIP_ETID, id, fields });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'Bitrix: ' + e.message }); }
});
// Чек-лист готовности (12 enum-полей Да/Нет/Не применимо) + тип услуг. Заполняет
// исполнитель (ответственный инженер) или админ.
router.post('/trips/:id(\\d+)/checklist', requireAuth(), express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); const b = req.body || {};
    const gr = await b24('crm.item.get', { entityTypeId: TRIP_ETID, id });
    const it = gr && gr.result && gr.result.item; if (!it) return res.status(404).json({ error: 'Не найдено' });
    const admin = ['admin', 'superadmin', 'coordinator'].includes(req.user.role);
    if (!admin && String(req.user.bitrix_user_id) !== String(it.assignedById)) return res.status(403).json({ error: 'Чек-лист заполняет ответственный за командировку' });
    const fields = {}; const vals = b.values || {};
    for (const c of TRIP_CHECK_CODES) { if (vals[c] != null && vals[c] !== '') fields[c] = String(vals[c]); }
    if (b.serviceTypeId != null && b.serviceTypeId !== '') fields[TRIP_SVC_FIELD] = [String(b.serviceTypeId)];
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Нечего сохранять' });
    await b24('crm.item.update', { entityTypeId: TRIP_ETID, id, fields });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'Bitrix: ' + e.message }); }
});
// Закрытие: дата принятия расходов + причина отправки финдокументов на доработку.
router.post('/trips/:id(\\d+)/closing', requireAuth(), express.json(), async (req, res) => {
  try {
    const cfg = await getTripApprovers();
    if (!_canFinance(req, cfg)) return res.status(403).json({ error: 'Недостаточно прав' });
    const id = parseInt(req.params.id, 10); const b = req.body || {}; const fields = {};
    if (b.acceptDate) fields[TRIP_CLOSE.acceptDate] = String(b.acceptDate);
    if (b.reworkReason != null) fields[TRIP_CLOSE.reworkReason] = String(b.reworkReason).slice(0, 2000);
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'Нечего сохранять' });
    await b24('crm.item.update', { entityTypeId: TRIP_ETID, id, fields });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'Bitrix: ' + e.message }); }
});
// Загрузка файла в поле командировки (приказ, финдокументы, документы проезда/проживания).
// Добавляет к существующим файлам (multiple file-поле): текущие id + новый fileData(base64).
const TRIP_FILE_FIELDS = { orderFile: TRIP_ORDER.file, avr: TRIP_FIN.avr, docsProzh: TRIP_FIN.docsProzh, docsProezd: TRIP_FIN.docsProezd };
router.post('/trips/:id(\\d+)/file', requireAuth(), express.json({ limit: '25mb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10); const b = req.body || {};
    const code = TRIP_FILE_FIELDS[b.field]; if (!code) return res.status(400).json({ error: 'Неизвестное поле' });
    const name = String(b.name || 'file').slice(0, 200); const data = String(b.dataBase64 || '');
    if (!data) return res.status(400).json({ error: 'Пустой файл' });
    const gr = await b24('crm.item.get', { entityTypeId: TRIP_ETID, id });
    const it = gr && gr.result && gr.result.item; if (!it) return res.status(404).json({ error: 'Не найдено' });
    const admin = ['admin', 'superadmin', 'coordinator'].includes(req.user.role);
    const cfg = await getTripApprovers();
    if (!admin && !_canFinance(req, cfg) && String(req.user.bitrix_user_id) !== String(it.assignedById)) return res.status(403).json({ error: 'Недостаточно прав' });
    const cur = it[code]; const ids = Array.isArray(cur) ? cur.map(x => (x && (x.id || x.ID)) || x).filter(Boolean) : [];
    const value = [...ids, { fileData: [name, data] }];
    await b24('crm.item.update', { entityTypeId: TRIP_ETID, id, fields: { [code]: value } });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: 'Bitrix: ' + e.message }); }
});

// ── Probe полей командировки (1074) — для сборки формы создания (Фаза 2) ──
// Отдаёт структуру всех полей (тип, обязательность, enum-значения, настройки
// привязок), пример элемента (?id=NN) и явную раскладку 12 обязательных кодов,
// чтобы понять, что из них enum/iblock/crm-привязка, прежде чем строить форму.
const TRIP_DEPT = 'ufCrm12_1732866897', TRIP_SUPERVISOR = 'ufCrm12_1732866961';
const TRIP_CONTRACT = 'ufCrm12_1732867028', TRIP_CITY = 'ufCrm12_1732867174';
const TRIP_TRANSPORT = 'ufCrm12_1732867253410', TRIP_TICKETS = 'ufCrm12_1732867331114';
const TRIP_LODGING = 'ufCrm12_1732867384914';
router.get('/trip-fields', requireAuth(), requirePlannerAdmin, async (req, res) => {
  try {
    const out = {};
    try {
      const fr = await b24('crm.item.fields', { entityTypeId: TRIP_ETID });
      const f = (fr && fr.result && fr.result.fields) || {};
      out.fields = Object.entries(f).map(([code, m]) => ({
        code, title: (m && m.title) || '', type: (m && m.type) || '',
        required: !!(m && m.isRequired), multiple: !!(m && m.isMultiple),
        items: (m && m.items) ? m.items.map(i => ({ id: i.ID != null ? i.ID : i.id, name: i.VALUE != null ? i.VALUE : i.value })) : undefined,
        settings: (m && m.settings) || undefined,
      }));
      const KEY = { dept: TRIP_DEPT, supervisor: TRIP_SUPERVISOR, contract: TRIP_CONTRACT,
        purpose: TRIP_PURPOSE, city: TRIP_CITY, dest: TRIP_DEST, transport: TRIP_TRANSPORT,
        route: TRIP_ROUTE, start: TRIP_START, end: TRIP_END, tickets: TRIP_TICKETS, lodging: TRIP_LODGING };
      out.required12 = Object.fromEntries(Object.entries(KEY).map(([k, code]) => [k, out.fields.find(x => x.code === code) || { code, missing: true }]));
    } catch (e) { out.fieldsError = e.message; }
    const id = parseInt(req.query.id, 10) || null;
    if (id) {
      try { const ir = await b24('crm.item.get', { entityTypeId: TRIP_ETID, id }); out.sample = (ir && ir.result && ir.result.item) || null; }
      catch (e) { out.sampleError = e.message; }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Справочники для формы создания командировки (Фаза 2) ──────────────────
// Сотрудники (ответственный/руководитель), enum транспорта/билетов, простой
// enum подразделения + список контрактов (смарт-процесс 1036). Город/подразделение
// как iblock — пробуем вытащить через lists.*; если недоступно, форма их скрывает.
const TRIP_DEPT_ENUM = 'ufCrm12_1737959461';           // «Подразделение» (enum, 5 опций)
const TRIP_CONTRACT_SPA = 1036;                        // «Регистрация контрактов»
let _tripMeta = null, _tripMetaAt = 0;
const _withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const _lel = (res) => ((res && res.result) || []).map(x => ({ id: x.ID || x.id, name: x.NAME || x.name })).filter(x => x.id && x.name);
router.get('/trip-meta', requireAuth(), async (req, res) => {
  try {
    if (_tripMeta && Date.now() - _tripMetaAt < 600e3 && !req.query.fresh) return res.json(_tripMeta);
    const out = { staff: [], transport: [], tickets: [], dept: [], contracts: [], cities: [], serviceTypes: [], departments: [] };
    const [staffR, fieldsR, contractsR, citiesR, svcR, depR] = await Promise.allSettled([
      pool.query("SELECT bitrix_user_id AS bid, name, department, job_title FROM ticketsmodule_staff_ref WHERE bitrix_user_id IS NOT NULL AND (active IS NULL OR active = TRUE) ORDER BY name"),
      _withTimeout(b24('crm.item.fields', { entityTypeId: TRIP_ETID }), 8000),
      _withTimeout(b24('crm.item.list', { entityTypeId: TRIP_CONTRACT_SPA, order: { id: 'desc' }, select: ['id', 'title'] }), 8000),
      _withTimeout(b24('lists.element.get', { IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: 17, select: ['ID', 'NAME'] }), 8000),
      _withTimeout(b24('lists.element.get', { IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: 25, select: ['ID', 'NAME'] }), 8000),
      _withTimeout(b24('department.get', {}), 8000),
    ]);
    if (staffR.status === 'fulfilled') out.staff = (staffR.value.rows || []).map(r => ({ bid: r.bid, name: r.name, dept: r.department || '', job: r.job_title || '' }));
    if (fieldsR.status === 'fulfilled') {
      const f = (fieldsR.value && fieldsR.value.result && fieldsR.value.result.fields) || {};
      const en = code => (((f[code] && f[code].items) || []).map(i => ({ id: i.ID != null ? i.ID : i.id, name: i.VALUE != null ? i.VALUE : i.value })));
      out.transport = en(TRIP_TRANSPORT); out.tickets = en(TRIP_TICKETS); out.dept = en(TRIP_DEPT_ENUM);
      out.checklist = TRIP_CHECK.map(c => ({ code: c.code, label: c.label, items: en(c.code) }));
    } else { out.fieldsErr = String(fieldsR.reason && fieldsR.reason.message || fieldsR.reason); }
    if (contractsR.status === 'fulfilled') {
      const r = contractsR.value;
      out.contracts = ((r && r.result && r.result.items) || []).map(i => ({ id: i.id, title: i.title || ('№ ' + i.id) })).slice(0, 800);
    } else { out.contractsErr = String(contractsR.reason && contractsR.reason.message || contractsR.reason); }
    if (citiesR.status === 'fulfilled') out.cities = _lel(citiesR.value);
    if (svcR.status === 'fulfilled') out.serviceTypes = _lel(svcR.value);
    if (depR.status === 'fulfilled') {
      const r = depR.value; const arr = (r && r.result && r.result.result) ? r.result.result : (r && r.result) || [];
      out.departments = (Array.isArray(arr) ? arr : []).map(d => ({ id: d.ID || d.id, name: d.NAME || d.name })).filter(x => x.id && x.name);
    }
    _tripMeta = out; _tripMetaAt = Date.now();
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Живой поиск компаний Б24 (для поля «Заказчик»).
router.get('/company-search', requireAuth(), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });
    const r = await _withTimeout(b24('crm.company.list', { filter: { '%TITLE': q }, select: ['ID', 'TITLE'], order: { TITLE: 'ASC' } }), 7000);
    const items = ((r && r.result) || []).slice(0, 30).map(c => ({ id: c.ID, title: c.TITLE }));
    res.json({ items });
  } catch (e) { res.json({ items: [], error: e.message }); }
});
// Создание командировки из карточки: элемент 1074 (стадия «Запрос») + блок в
// Планировщике (type=trip, подтверждён, связан по bitrix_item_id).
router.post('/trips', requireAuth(), express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const resource = String(b.resource || '').trim();
    const start = String(b.start || '').slice(0, 10);
    const end = String(b.end || start).slice(0, 10);
    const purpose = String(b.purpose || '').trim();
    const dest = String(b.dest || '').trim();
    const route = String(b.route || '').trim();
    if (!resource || !start || !purpose || !dest) return res.status(400).json({ error: 'Нужны сотрудник, дата начала, цель и пункт назначения' });
    const engineerId = await resolveBitrixUserId(resource);
    const title = `Командировка ${resource} (${dest}, ${_ddmmyyyy(start)} - ${_ddmmyyyy(end)})`;
    const fields = {
      title, categoryId: TRIP_CAT,
      [TRIP_START]: start, [TRIP_END]: end,
      [TRIP_PURPOSE]: purpose, [TRIP_DEST]: [dest], [TRIP_ROUTE]: route || dest,
    };
    if (engineerId) fields.assignedById = engineerId;
    if (b.supervisorBid) fields[TRIP_SUPERVISOR] = b.supervisorBid;
    if (Array.isArray(b.transport) && b.transport.length) fields[TRIP_TRANSPORT] = b.transport.map(String);
    else if (b.transport) fields[TRIP_TRANSPORT] = [String(b.transport)];
    if (b.tickets) fields[TRIP_TICKETS] = String(b.tickets);
    if (b.lodging != null && b.lodging !== '') fields[TRIP_LODGING] = Number(b.lodging) || 0;
    if (b.deptEnum) fields[TRIP_DEPT_ENUM] = String(b.deptEnum);
    if (b.deptSectionId) fields[TRIP_DEPT] = String(b.deptSectionId);
    if (b.cityId) fields[TRIP_CITY] = [String(b.cityId)];
    if (b.contractId) fields[TRIP_CONTRACT] = [`DYNAMIC_${TRIP_CONTRACT_SPA}_${b.contractId}`];
    if (b.companyId) fields.companyId = Number(b.companyId) || b.companyId;
    if (b.subject) fields['ufCrm12_1732867088884'] = [String(b.subject)];
    if (b.perdiemKz != null && b.perdiemKz !== '') fields[TRIP_FIN.perdiemKz] = Number(b.perdiemKz) || 0;
    if (b.travel != null && b.travel !== '') fields[TRIP_FIN.travel] = Number(b.travel) || 0;
    if (b.total != null && b.total !== '') fields[TRIP_FIN.total] = String(b.total);
    if (b.serviceTypeId) fields[TRIP_SVC_FIELD] = [String(b.serviceTypeId)];
    if (b.changeParentId) fields[TRIP_CHANGE.parent] = `DYNAMIC_${TRIP_ETID}_${b.changeParentId}`;
    if (b.changeReason) fields[TRIP_CHANGE.reason] = String(b.changeReason).slice(0, 2000);
    let bid = null;
    try { const r = await b24('crm.item.add', { entityTypeId: TRIP_ETID, fields }); bid = (r && r.result && r.result.item && r.result.item.id) || null; }
    catch (e) { return res.status(502).json({ error: 'Bitrix: ' + e.message }); }
    try {
      const evFields = JSON.stringify({ dest, purpose, route: route || null, supervisorBid: b.supervisorBid || null });
      const ev = await pool.query(
        `INSERT INTO ticketsmodule_planner_events (group_id, resource, title, type, start_at, end_at, all_day, confirmed, fields, bitrix_item_id, source, created_by)
         VALUES (0,$1,$2,'trip',$3::timestamp AT TIME ZONE '${TZ}',$4::timestamp AT TIME ZONE '${TZ}',true,true,$5,$6,'manual',$7) RETURNING id`,
        [resource, title, start + 'T09:00', end + 'T18:00', evFields, bid, (req.user && req.user.username) || null]);
      await pool.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$1', [ev.rows[0].id]);
    } catch (e) { console.error('trip card → planner block:', e.message); }
    invalidateTripStageCache();
    res.json({ ok: true, id: bid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Probe списков iblock (Подразделение УС=3, Город=17, Тип услуг=25) — ищем рабочий
// метод/тип, чтобы подтягивать опции в форму. ?id=3|17|25.
router.get('/iblock-probe', requireAuth(), requirePlannerAdmin, async (req, res) => {
  const iblock = parseInt(req.query.id, 10) || 3;
  const TO = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const call = (method, params) => TO(b24(method, params), 7000).then(r => (r && r.result !== undefined) ? r.result : r).catch(e => ({ _err: e.message }));
  const jobs = {
    listsLists: call('lists.get', { IBLOCK_TYPE_ID: 'lists' }),
    listsProc: call('lists.get', { IBLOCK_TYPE_ID: 'bitrix_processes' }),
    sec_lists: call('lists.section.get', { IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: iblock }),
    el_lists: call('lists.element.get', { IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: iblock, select: ['ID', 'NAME'] }),
    sec_proc: call('lists.section.get', { IBLOCK_TYPE_ID: 'bitrix_processes', IBLOCK_ID: iblock }),
    el_proc: call('lists.element.get', { IBLOCK_TYPE_ID: 'bitrix_processes', IBLOCK_ID: iblock, select: ['ID', 'NAME'] }),
  };
  const keys = Object.keys(jobs);
  const results = await Promise.all(keys.map(k => jobs[k]));
  const out = { iblock };
  keys.forEach((k, i) => {
    let v = results[i];
    if (Array.isArray(v)) v = v.slice(0, 60).map(x => ({ ID: x.ID || x.id, NAME: x.NAME || x.name, IBLOCK_TYPE_ID: x.IBLOCK_TYPE_ID, IBLOCK_ID: x.ID }));
    out[k] = v;
  });
  res.json(out);
});

module.exports = { router, rowToEvent, SELECT_COLS, TZ, syncStaffFromBitrix, fetchAllActiveUsers, computeSyncHash, resolveBitrixUserId };


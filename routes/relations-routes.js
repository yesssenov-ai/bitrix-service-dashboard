const express = require('express');
const router = express.Router();
const { requireAuth, pool, isAdminLike } = require('../auth');
const { EMPLOYEE_DEPT } = require('../dept-map');
const {
  SMART_TYPES, getItem, getDeal, buildTree, searchDeals, findParent, isFinalStage, WEBHOOK_TOKEN,
  getDealsByManager, SALES_CATEGORIES, resolveStageName,
} = require('../relations');
const { tgMgt, tgOps } = require('../notifications');
const { notifyProcessCompleted, notifyEngineerAssigned, notifyJobAssigned, setPool: setMgrNotifyPool } = require('../manager-notifications');
const { USERS } = require('../constants');
const { b24 } = require('../bitrix');
const { computeSyncHash } = require('./planner-routes');
const {
  SERVICE_TYPE_MAP, AREA_MAP, getPriborMap, getCompanyName, resolveCrmFieldLabel,
  getContractFromChain, getRootDealManager, fmtDateOnly, fmtLocalNaive, wasRecentlyDeleted,
} = require('../bitrix-lookups');

const serviceStats = require('../service-stats');
// Стадии командировки (1074), которые считаем «согласована» — для зеркала
// статистики (то же множество, что в planner-routes для цвета бара).
const STATS_TRIP_APPROVED = new Set(['DT1074_15:CLIENT', 'DT1074_15:1', 'DT1074_15:2', 'DT1074_15:3', 'DT1074_15:SUCCESS']);

setMgrNotifyPool(pool);

// Колонки связи «заявка 1058 → командировка 1074» в событии планировщика
// (для Варианта 1: командировка из заявки не плодит второй бар, а помечает бар заявки).
(async () => {
  try {
    await pool.query('ALTER TABLE ticketsmodule_planner_events ADD COLUMN IF NOT EXISTS command_item_id BIGINT');
    await pool.query('ALTER TABLE ticketsmodule_planner_events ADD COLUMN IF NOT EXISTS command_stage VARCHAR(64)');
  } catch (e) { console.error('planner command cols:', e.message); }
})();

// ── Скоупинг «Связей» по роли: menedzher (sales) — только свои сделки;
// руководитель отдела (sales_head) — все менеджеры своего отдела; admin/superadmin
// и manager — все. Возвращает Set разрешённых Bitrix-ID менеджеров или null (все).
function relBid(user) {
  if (user && user.bitrix_user_id) return parseInt(user.bitrix_user_id, 10);
  const nm = user && (user.engineer_name || user.display_name);
  if (nm) { const f = Object.entries(USERS).find(([, n]) => n === nm); if (f) return parseInt(f[0], 10); }
  return null;
}
function relAllowedManagers(user) {
  const role = user && user.role;
  if (isAdminLike(role) || role === 'manager' || role === 'coordinator') return null; // все
  const bid = relBid(user);
  const s = new Set();
  if (bid) s.add(bid);
  if (role === 'sales_head') {
    const dept = bid ? EMPLOYEE_DEPT[bid] : null;
    if (dept) for (const [b, d] of Object.entries(EMPLOYEE_DEPT)) if (d === dept) s.add(parseInt(b, 10));
  }
  return s; // sales и прочие — только свои
}

// ── Planner sync (Заявка на сервис 1058 → ticketsmodule_planner_events) ────
const PLANNER_TZ = 'Asia/Almaty';

// Sync one Заявка на сервис (1058) item into the shared planner events table.
// Only creates/updates an event once engineer + both dates + service type +
// company are all filled in — regardless of which stage the request is on.
// If those fields are later cleared out again, the synced event is removed.
async function syncPlannerEvent(item, itemId, opts = {}) {
  const engineerId = parseInt(item.ufCrm8_1732856367, 10);
  const startRaw = item.ufCrm8_1764742554715;
  const endRaw = item.ufCrm8_1764742724958;
  const svcIds = Array.isArray(item.ufCrm8_1744300223) ? item.ufCrm8_1744300223 : (item.ufCrm8_1744300223 ? [item.ufCrm8_1744300223] : []);
  const companyId = parseInt(item.companyId, 10);

  // «Подготовительные» заявки по типу услуг (Подбор допов 111 / Подготовка документов 402 /
  // Чек-лист готовности 730): красим отдельным цветом (fields.prep) и при завершении
  // (стадия исполнена/завершена/закрыта — семантика S/F) убираем из планировщика.
  const PREP_TYPES = new Set(['111', '402', '730']);
  const isPrep = svcIds.some(id => PREP_TYPES.has(String(id)));
  // «Заявка клиента» (УС 619): по умолчанию коричневый бар; но если по ней
  // оформлена командировка — красится как обычный выезд (светло-/тёмно-зелёный
  // по согласованию командировки). Логика цвета — на фронте по fields.clientReq.
  const isClientReq = svcIds.some(id => String(id) === '619');
  if (isPrep) {
    let completed = false;
    // isFinalStage ходит в Битрикс за семантикой стадии; через туннель один
    // «холодный» вызов может зависнуть и застопорить всю последовательную сверку.
    // Ограничиваем по времени: не определили за 8с → считаем «не завершена»
    // (бар останется, перекрасится в prep), чтобы проход не вставал.
    try {
      completed = await Promise.race([
        isFinalStage(1058, item.categoryId, item.stageId),
        new Promise((_, rej) => setTimeout(() => rej(new Error('isFinalStage timeout')), 8000)),
      ]);
    } catch (e) { /* таймаут/ошибка — не трогаем, считаем не завершённой */ }
    if (completed) {
      try { await pool.query("DELETE FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 AND type='trip'", [itemId]); }
      catch (e) { console.error('Planner prep cleanup error:', e.message); }
      return { removed: true };
    }
  }

  const ready = engineerId && startRaw && endRaw && svcIds.length && companyId;
  if (!ready) {
    // Required data isn't (or is no longer) complete — remove any previously
    // synced event for this item so the planner doesn't show a stale job.
    try { await pool.query("DELETE FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 AND type='trip'", [itemId]); }
    catch (e) { console.error('Planner sync cleanup error:', e.message); }
    return;
  }

  const engineerName = USERS[engineerId];
  if (!engineerName) {
    console.warn(`Planner sync: unknown Bitrix user #${engineerId} (item ${itemId}) — skipping`);
    return;
  }

  const sDate = new Date(startRaw); sDate.setHours(9, 0, 0, 0);
  const eDate = new Date(endRaw); eDate.setHours(18, 0, 0, 0);
  if (isNaN(sDate) || isNaN(eDate)) return;

  const startLocal = fmtLocalNaive(sDate), endLocal = fmtLocalNaive(eDate);
  const newHash = computeSyncHash(engineerId, startLocal.slice(0, 10), endLocal.slice(0, 10));
  // Фоновая сверка передаёт карту известных хэшей (bitrix_item_id → hash).
  // Если заявка уже есть и инженер+даты не менялись — сверке тут делать нечего:
  // пропускаем тяжёлые запросы в Битрикс (прибор/компания/договор) и БД целиком.
  // Живой вебхук карту НЕ передаёт → полный путь как раньше.
  if (opts.knownHashes && opts.knownHashes.get(Number(itemId)) === newHash) return { skipped: true };

  const svcLabel = SERVICE_TYPE_MAP[svcIds[0]] || '';
  const priborIds = Array.isArray(item.ufCrmPribor) ? item.ufCrmPribor : (item.ufCrmPribor ? [item.ufCrmPribor] : []);
  let instrLabel = '';
  if (priborIds.length) {
    const map = await getPriborMap();
    instrLabel = priborIds.map(id => map[id] || id).join(', ');
  }
  const clientName = await getCompanyName(companyId);
  const location = item.ufCrm8_1732855494458 || '';
  const areaIds = Array.isArray(item.ufCrm8_1732855428) ? item.ufCrm8_1732855428 : (item.ufCrm8_1732855428 ? [item.ufCrm8_1732855428] : []);
  const areaLabel = areaIds.length ? (AREA_MAP[areaIds[0]] || '') : '';
  const datesConfirmedRaw = item.ufCrm8_1785151880;
  const datesConfirmed = datesConfirmedRaw === 'Y' || datesConfirmedRaw === '1' || datesConfirmedRaw === 1 || datesConfirmedRaw === true;
  let contractLabel = await getContractFromChain(1058, item);
  if (!contractLabel) contractLabel = await resolveCrmFieldLabel(item.ufCrm8_1732855521);

  const fieldsObj = { df1: areaLabel, df2: location, df3: svcLabel, df4: instrLabel, prep: isPrep, clientReq: isClientReq };
  const clientsArr = clientName ? [{ name: clientName, type: '' }] : [];
  const title = item.title || '';

  const client = await pool.connect();
  let notifyKind = null; // null | 'new' | array of change reasons like ['engineer','dates']
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, resource, bitrix_sync_hash,
        to_char(start_at AT TIME ZONE '${PLANNER_TZ}', 'YYYY-MM-DD') AS start_date_old,
        to_char(end_at AT TIME ZONE '${PLANNER_TZ}', 'YYYY-MM-DD') AS end_date_old
       FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 AND type='trip'`, [itemId]
    );

    if (rows.length && rows[0].bitrix_sync_hash === newHash) {
      // Bitrix's current engineer+dates match what we last recorded — this
      // is either an echo of our own outbound push, or an unrelated field
      // changed on the request. Either way, don't touch resource/dates/
      // confirmed (a newer local planner edit may be mid-flight, and this
      // was overwriting a manual "Подтверждено" uncheck on every sync pass);
      // just refresh the read-only fields.
      // Пишем ТОЛЬКО если что-то из read-only полей реально изменилось.
      // Иначе фоновая сверка (каждые 10 мин × все заявки) гнала «слепой» UPDATE
      // на каждую строку каждый проход — 3М пустых записей/мес (dead tuples,
      // WAL, autovacuum). IS DISTINCT FROM → 0 строк тронуто, когда всё совпало.
      await client.query(
        `UPDATE ticketsmodule_planner_events SET title=$1, fields=$2, clients=$3, updated_at=NOW()
         WHERE id=$4 AND (title IS DISTINCT FROM $1
                          OR fields IS DISTINCT FROM $2::jsonb
                          OR clients IS DISTINCT FROM $3::jsonb)`,
        [title, JSON.stringify(fieldsObj), JSON.stringify(clientsArr), rows[0].id]
      );
    } else if (rows.length) {
      const changes = [];
      if (rows[0].resource !== engineerName) changes.push('engineer');
      if (rows[0].start_date_old !== startLocal.slice(0,10) || rows[0].end_date_old !== endLocal.slice(0,10)) changes.push('dates');
      if (changes.length) notifyKind = changes;
      await client.query(
        `UPDATE ticketsmodule_planner_events
         SET resource=$1, title=$2, type='trip',
             start_at=$3::timestamp AT TIME ZONE '${PLANNER_TZ}',
             end_at=$4::timestamp AT TIME ZONE '${PLANNER_TZ}',
             confirmed=$5, fields=$6, clients=$7, bitrix_sync_hash=$8, updated_at=NOW()
         WHERE id=$9`,
        [engineerName, title, startLocal, endLocal, datesConfirmed, JSON.stringify(fieldsObj), JSON.stringify(clientsArr), newHash, rows[0].id]
      );
    } else {
      notifyKind = wasRecentlyDeleted(itemId) ? null : 'new';
      const { rows: ins } = await client.query(
        `INSERT INTO ticketsmodule_planner_events
          (group_id, resource, title, type, start_at, end_at, all_day, confirmed, note, fields, clients, bitrix_item_id, source, bitrix_sync_hash)
         VALUES (0,$1,$2,'trip',
             $3::timestamp AT TIME ZONE '${PLANNER_TZ}', $4::timestamp AT TIME ZONE '${PLANNER_TZ}',
             false, $5, '', $6,$7,$8,'bitrix',$9)
         RETURNING id`,
        [engineerName, title, startLocal, endLocal, datesConfirmed, JSON.stringify(fieldsObj), JSON.stringify(clientsArr), itemId, newHash]
      );
      await client.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$1', [ins[0].id]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Planner sync error:', e.message);
    try { await tgOps(`⚠️ Планировщик: не удалось синхронизировать заявку #${itemId}\n${e.message}`); } catch(e2){}
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }

  if (notifyKind) {
    if (opts.silent) {
      // Created/updated by the background reconciliation sweep, not the live
      // webhook — we deliberately don't send a notification here (see the
      // mass-notification incident), but log that fact so it's distinguishable
      // from "we tried and it failed" or "nothing was ever attempted".
      try {
        const { logNotification } = require('../manager-notifications');
        await logNotification({
          itemId, reason: 'Пропущено (фоновая сверка, не живой вебхук)',
          channel: 'skipped', recipientId: null, recipientLabel: null, success: false,
        });
      } catch (e) { /* logging is best-effort */ }
    } else {
    try {
      const mgr = await getRootDealManager(1058, item);
      const managerId = mgr?.managerId;
      const managerName = managerId ? (USERS[managerId] || `Пользователь #${managerId}`) : '';
      const itemUrl = `https://crm.prolabsupport.kz/crm/type/1058/details/${itemId}/`;
      const dealUrl = mgr?.dealId ? `https://crm.prolabsupport.kz/crm/deal/details/${mgr.dealId}/` : null;

      let reason = 'Назначен инженер на заявку';
      if (Array.isArray(notifyKind)) {
        const parts = [];
        if (notifyKind.includes('engineer')) parts.push('изменён инженер');
        if (notifyKind.includes('dates')) parts.push('изменены даты работ');
        reason = 'Обновление по заявке: ' + parts.join(', ');
      }

      await notifyJobAssigned({
        engineerId, managerId, itemId, title, reason,
        svcLabel, engineerName,
        assignDate: fmtDateOnly(new Date()),
        startDate: fmtDateOnly(sDate), endDate: fmtDateOnly(eDate),
        clientName, contractLabel, managerName, instrLabel, location,
        url: itemUrl, dealUrl,
      });
    } catch (e) {
      console.error('notifyJobAssigned error:', e.message);
      try { await tgOps(`⚠️ Планировщик: заявка #${itemId} синхронизирована, но уведомление не отправлено\n${e.message}`); } catch(e2){}
    }
    }
  }
  return { ok: true };
}

// ── Входящий синк Отпусков (1108) и Встреч (воронка 4) в Планировщик ───────
// Событие в планировщике уникально по (bitrix_item_id, type): id в разных
// сущностях Bitrix пересекаются, а тип (leave/meeting/trip/command) различает.
const LV = { start: 'ufCrm19_1782732324', end: 'ufCrm19_1782732517', type: 'ufCrm19_1782733656', days: 'ufCrm19_1782732922' };
const MT = { date: 'ufCrm_1736508416174', short: 'ufCrm_1736508064357', loc: 'ufCrm_1736508501960' };
async function upsertBitrixEvent({ itemId, type, resourceId, resource, title, start, end, confirmed, fields }) {
  if (!resource || !start || !end) { try { await pool.query('DELETE FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 AND type=$2', [itemId, type]); } catch (e) {} return; }
  const sD = new Date(start); sD.setHours(9, 0, 0, 0); const eD = new Date(end); eD.setHours(18, 0, 0, 0);
  if (isNaN(sD) || isNaN(eD)) return;
  const sL = fmtLocalNaive(sD), eL = fmtLocalNaive(eD);
  const hash = computeSyncHash(resourceId || 0, sL.slice(0, 10), eL.slice(0, 10));
  const fJson = JSON.stringify(fields || {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, bitrix_sync_hash FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 AND type=$2', [itemId, type]);
    if (rows.length && rows[0].bitrix_sync_hash === hash) {
      await client.query(`UPDATE ticketsmodule_planner_events SET title=$1, fields=$2, updated_at=NOW() WHERE id=$3 AND (title IS DISTINCT FROM $1 OR fields IS DISTINCT FROM $2::jsonb)`, [title, fJson, rows[0].id]);
    } else if (rows.length) {
      await client.query(`UPDATE ticketsmodule_planner_events SET resource=$1,title=$2,start_at=$3::timestamp AT TIME ZONE '${PLANNER_TZ}',end_at=$4::timestamp AT TIME ZONE '${PLANNER_TZ}',confirmed=$5,fields=$6,bitrix_sync_hash=$7,updated_at=NOW() WHERE id=$8`, [resource, title, sL, eL, !!confirmed, fJson, hash, rows[0].id]);
    } else {
      const ins = await client.query(`INSERT INTO ticketsmodule_planner_events (group_id,resource,title,type,start_at,end_at,all_day,confirmed,note,fields,clients,bitrix_item_id,source,bitrix_sync_hash) VALUES (0,$1,$2,$3,$4::timestamp AT TIME ZONE '${PLANNER_TZ}',$5::timestamp AT TIME ZONE '${PLANNER_TZ}',false,$6,'',$7,'[]',$8,'bitrix',$9) RETURNING id`, [resource, title, type, sL, eL, !!confirmed, fJson, itemId, hash]);
      await client.query('UPDATE ticketsmodule_planner_events SET group_id=$1 WHERE id=$1', [ins.rows[0].id]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.error('upsertBitrixEvent(' + type + ') error:', e.message); }
  finally { client.release(); }
}
async function syncLeaveEvent(item, itemId) {
  const engId = parseInt(item.assignedById, 10); const name = engId ? USERS[engId] : null;
  await upsertBitrixEvent({ itemId, type: 'leave', resourceId: engId, resource: name, title: name ? ('Отпуск — ' + name) : 'Отпуск', start: item[LV.start], end: item[LV.end], confirmed: true, fields: { leaveDays: item[LV.days] || null, leaveType: item[LV.type] || null } });
}
async function syncMeetingEvent(item, itemId) {
  const engId = parseInt(item.assignedById, 10); const name = engId ? USERS[engId] : null;
  const d = item[MT.date];
  await upsertBitrixEvent({ itemId, type: 'meeting', resourceId: engId, resource: name, title: item[MT.short] || item.title || 'Встреча', start: d, end: d, confirmed: false, fields: { df2: item[MT.loc] || '' } });
}
// Командировка (1074). Вариант 1 (дедуп): если у неё есть родительская Заявка на
// сервис (parentId1058) — НЕ плодим второй бар, а помечаем бар заявки (command_item_id
// + command_stage). Отдельная командировка (без заявки) — свой бар type='command'.
const TR = { start: 'ufCrm12_1732867277610', end: 'ufCrm12_1732867286706', dest: 'ufCrm12_1732867225794' };
async function syncTripCommand(item, itemId) {
  const parent = parseInt(item.parentId1058, 10) || null;
  const stageId = item.stageId || '';
  if (parent) {
    try {
      const r = await pool.query("UPDATE ticketsmodule_planner_events SET command_item_id=$1, command_stage=$2, updated_at=NOW() WHERE bitrix_item_id=$3 AND type='trip' AND (command_item_id IS DISTINCT FROM $1 OR command_stage IS DISTINCT FROM $2)", [itemId, stageId, parent]);
      // если ранее была как отдельный бар — убрать дубль
      await pool.query("DELETE FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1 AND type='command'", [itemId]);
    } catch (e) { console.error('trip command attach:', e.message); }
    return;
  }
  const engId = parseInt(item.assignedById, 10); const name = engId ? USERS[engId] : null;
  const dest = Array.isArray(item[TR.dest]) ? item[TR.dest][0] : item[TR.dest];
  await upsertBitrixEvent({ itemId, type: 'command', resourceId: engId, resource: name, title: name ? ('Командировка — ' + (dest || name)) : 'Командировка', start: item[TR.start], end: item[TR.end], confirmed: true, fields: { df2: dest || '' } });
}

// ── Periodic reconciliation sweep ───────────────────────────────────────────
// Webhooks are inherently best-effort (Bitrix delivery hiccups, a restart at
// the wrong moment, etc.) — this walks every Заявка на сервис and re-runs the
// exact same sync logic, so any missed webhook is caught and fixed here
// instead of silently staying wrong until someone notices.
async function reconcileAllPlannerEvents(force = false) {
  let start = 0, checked = 0, errors = 0, skipped = 0;
  const failedIds = [];
  // Один запрос вместо SELECT на каждую заявку: карта «bitrix_item_id → hash»
  // уже синхронизированных строк. Заявки, где инженер+даты не менялись,
  // пропускаются в syncPlannerEvent без обращения к Битриксу и БД.
  // force=true (разовая актуализация) — пропуск по хэшу отключаем, чтобы
  // перепроставить флаги (prep) и подчистить завершённые на ВСЕХ заявках.
  const knownHashes = new Map();
  if (!force) try {
    const { rows } = await pool.query(
      "SELECT bitrix_item_id, bitrix_sync_hash FROM ticketsmodule_planner_events WHERE source='bitrix' AND bitrix_item_id IS NOT NULL"
    );
    for (const r of rows) knownHashes.set(Number(r.bitrix_item_id), r.bitrix_sync_hash);
  } catch (e) { console.error('reconcileAllPlannerEvents preload error:', e.message); }
  // Набор id всех живых заявок 1058 (то, что реально вернул crm.item.list —
  // авторитетный источник «существует»). Нужен для чистки орфанов ниже.
  const seenIds = new Set();
  let listComplete = true;   // проход дошёл до конца без ошибки списка
  let listTotal = null;      // crm.item.list.total — полное число заявок
  while (true) {
    let items, next;
    try {
      const resp = await b24('crm.item.list', { entityTypeId: 1058, select: ['*', 'uf_*'], order: { id: 'asc' }, start });
      items = resp.result?.items || [];
      next = resp.next;
      if (listTotal === null && typeof resp.total === 'number') listTotal = resp.total;
    } catch (e) {
      console.error('reconcileAllPlannerEvents: crm.item.list failed:', e.message);
      listComplete = false;
      break;
    }
    if (!items.length) break;
    for (const item of items) {
      seenIds.add(Number(item.id));
      checked++;
      const result = await syncPlannerEvent(item, item.id, { silent: true, knownHashes });
      if (result && result.ok === false) { errors++; failedIds.push(item.id); }
      else if (result && result.skipped) { skipped++; }
      // Зеркало статистики: все заявки (любой тип, завершённые и нет), не только «готовые».
      try { await serviceStats.upsertFromItem(item, item.id); } catch (e) {}
    }
    if (next === undefined || items.length < 50) break;
    start = next;
  }
  // ── Чистка орфанов: бары type='trip' (выезды/подготовка), чья заявка 1058
  // удалена в Битриксе — её нет в crm.item.list, поэтому построчный синк её
  // никогда не трогает и бар «висит» навсегда. Удаляем такие строки, НО только
  // когда проход был заведомо полным (seenIds покрывает total) — иначе
  // усечённая выборка могла бы снести валидные бары. Плюс предохранитель на
  // массовое удаление.
  let orphansRemoved = 0;
  try {
    const complete = listComplete && listTotal !== null && seenIds.size >= listTotal;
    if (complete && seenIds.size > 0) {
      const { rows } = await pool.query(
        "SELECT id, bitrix_item_id FROM ticketsmodule_planner_events WHERE source='bitrix' AND type='trip' AND bitrix_item_id IS NOT NULL"
      );
      const orphanRowIds = rows.filter(r => !seenIds.has(Number(r.bitrix_item_id))).map(r => r.id);
      const cap = Math.max(25, Math.ceil(rows.length * 0.2));
      if (orphanRowIds.length && orphanRowIds.length <= cap) {
        const del = await pool.query('DELETE FROM ticketsmodule_planner_events WHERE id = ANY($1::bigint[])', [orphanRowIds]);
        orphansRemoved = del.rowCount || 0;
      } else if (orphanRowIds.length) {
        console.warn(`Planner orphan cleanup: ${orphanRowIds.length} кандидатов > лимита ${cap} — пропускаю (возможен неполный проход).`);
        try { await tgOps(`⚠️ Планировщик: кандидатов в орфаны ${orphanRowIds.length} (> ${cap}) — чистка пропущена, проверьте вручную.`); } catch (e) {}
      }
    }
  } catch (e) { console.error('Planner orphan cleanup error:', e.message); }
  // Отпуска (1108) и Встречи (сделки воронки 4) — та же сверка, чтобы пропущенные
  // вебхуки догонялись.
  let lv = 0, mt = 0;
  try {
    let s2 = 0;
    while (true) {
      const resp = await b24('crm.item.list', { entityTypeId: 1108, select: ['*', 'uf_*'], order: { id: 'asc' }, start: s2 });
      const list = resp.result?.items || [];
      for (const it of list) { try { await syncLeaveEvent(it, it.id); lv++; } catch (e) {} }
      if (resp.next === undefined || list.length < 50) break; s2 = resp.next;
    }
  } catch (e) { console.error('reconcile leaves:', e.message); }
  try {
    let s3 = 0;
    while (true) {
      const resp = await b24('crm.item.list', { entityTypeId: 2, filter: { categoryId: 4 }, select: ['*', 'uf_*'], order: { id: 'asc' }, start: s3 });
      const list = resp.result?.items || [];
      for (const it of list) { try { await syncMeetingEvent(it, it.id); mt++; } catch (e) {} }
      if (resp.next === undefined || list.length < 50) break; s3 = resp.next;
    }
  } catch (e) { console.error('reconcile meetings:', e.message); }
  let tc = 0;
  try {
    let s4 = 0;
    while (true) {
      const resp = await b24('crm.item.list', { entityTypeId: 1074, select: ['*', 'uf_*'], order: { id: 'asc' }, start: s4 });
      const list = resp.result?.items || [];
      for (const it of list) {
        try { await syncTripCommand(it, it.id); tc++; } catch (e) {}
        // Зеркало статистики: отметить у заявки наличие/согласование командировки.
        try { if (it.parentId1058) await serviceStats.markTrip(it.parentId1058, STATS_TRIP_APPROVED.has(it.stageId)); } catch (e) {}
      }
      if (resp.next === undefined || list.length < 50) break; s4 = resp.next;
    }
  } catch (e) { console.error('reconcile commands:', e.message); }
  if (errors > 0) {
    try {
      await tgOps(`⚠️ Плановая сверка планировщика: ${errors} из ${checked} заявок не удалось синхронизировать (ID: ${failedIds.slice(0,20).join(', ')}${failedIds.length>20?'…':''})`);
    } catch (e) {}
  }
  console.log(`Planner reconciliation: checked ${checked}, skipped ${skipped} (unchanged), ${errors} error(s), orphans removed ${orphansRemoved}; отпусков ${lv}, встреч ${mt}, командировок ${tc}`);
  return { checked, skipped, errors, orphansRemoved };
}

// Entity types we track for completion notifications (per user request)
const TRACKED_FOR_COMPLETION = new Set([1058, 1066, 1070]); // Заявка на сервис, Закупки, Логистика

// Coordinator IDs whose assignment does NOT count as "engineer assigned"
const COORDINATOR_IDS = new Set([26, 79]);

// In-memory cache to avoid duplicate notifications for same item+stage
const notifiedCompletions = new Set();
const notifiedAssignments = new Map(); // itemId -> last assignedById seen

// ── GET /relations/search?q=... ───────────────────────────────────────────────
router.get('/search', requireAuth(), async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) return res.json({ ok: true, deals: [] });
  const deals = await searchDeals(q.trim());
  res.json({
    ok: true,
    deals: deals.map(d => ({
      id: d.ID, title: d.TITLE, stageId: d.STAGE_ID,
      opportunity: d.OPPORTUNITY, dateCreate: d.DATE_CREATE,
    })),
  });
});

// ── GET /relations/managers ───────────────────────────────────────────────────
router.get('/managers', requireAuth(), (req, res) => {
  // Reuse USERS dict via require from server context - import directly
  const USERS = {
    1:'Администратор',4:'Куаныш Есенов',7:'Мирас Актайлаков',8:'Рустам Абылкасимов',
    9:'Мурат Булегенов',10:'Асылбек Ожикен',11:'Гаухар Ахметжан',12:'Айжан Байжигитова',
    13:'Назерке Марат',14:'Канат Жунусов',15:'Семен Жаров',16:'Дамели Садырова',
    18:'Александр Якунин',19:'Ерлан Адильбеков',20:'Айнур Разакова',21:'Жадыра Сагитова',
    22:'Данияр Орахбаев',23:'Бахытгуль Даут',24:'Шокан Рымбек',25:'Рауан Жаксылык',
    26:'Азамат Аннабаев',27:'Маржан Доскенова',28:'Айнур Карпсеитова',29:'Борис Егоров',
    31:'Куаныш Нурмаганбетов',32:'Акерке Шотанова',33:'Аннель Лекер',34:'Гульнур Касымханова',
    36:'Аруна Болатова',37:'Акгулим Самиголлаева',38:'Талант Амангелді',39:'Мансұр Сейтжанұлы',
    40:'Каха Чоговадзе',41:'Наталья Зенченко',44:'Бақытжан Шаймұрат',45:'Азат Манат',
    46:'Жандос Кунаев',47:'Дмитрий Сорокин',48:'Дарын Негметжанов',50:'Нурбек Ибраемов',
    55:'Нурхат Оразгалиев',67:'Айнель Сеитова',68:'Игорь Бодров',71:'Азамат Алиев',
    73:'Ерасыл Махаш',76:'Аскат Көбей',77:'Адиль Тасмагамбетов',78:'Дмитрий Волков',
    79:'Арман Манаспаев',85:'Максим Мазняк',86:'Аманжол Сыздыков',88:'Асем Жарылгап',90:'Ерқанат Сырғабек',
  };
  const allow = relAllowedManagers(req.user); // null = все
  const managers = Object.entries(USERS)
    .filter(([id]) => Number(id) > 10)
    .filter(([id]) => !allow || allow.has(Number(id)))
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  res.json({ ok: true, managers });
});

// ── GET /relations/manager-deals/:managerId ───────────────────────────────────
router.get('/manager-deals/:managerId', requireAuth(), async (req, res) => {
  try {
    const managerId = parseInt(req.params.managerId);
    if (!managerId) return res.status(400).json({ ok: false, error: 'Invalid manager ID' });
    const allow = relAllowedManagers(req.user);
    if (allow && !allow.has(managerId)) return res.status(403).json({ ok: false, error: 'Нет доступа к сделкам этого менеджера' });
    const deals = await getDealsByManager(managerId);
    res.json({ ok: true, deals, categories: SALES_CATEGORIES });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /relations/tree/:dealId ───────────────────────────────────────────────
router.get('/tree/:dealId', requireAuth(), async (req, res) => {
  try {
    const dealId = parseInt(req.params.dealId);
    if (!dealId) return res.status(400).json({ ok: false, error: 'Invalid deal ID' });
    const tree = await buildTree('deal', dealId);
    if (!tree) return res.status(404).json({ ok: false, error: 'Сделка не найдена' });
    res.json({ ok: true, tree });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /relations/tree-from-item/:entityTypeId/:itemId ──────────────────────
// Build tree starting from a smart process item (finds root deal first, then full tree)
router.get('/tree-from-item/:entityTypeId/:itemId', requireAuth(), async (req, res) => {
  try {
    const entityTypeId = parseInt(req.params.entityTypeId);
    const itemId = parseInt(req.params.itemId);
    const item = await getItem(entityTypeId, itemId);
    if (!item) return res.status(404).json({ ok: false, error: 'Элемент не найден' });

    // Walk up to find root deal
    let current = { entityTypeId, item };
    let rootDealId = null;
    let safety = 0;
    while (safety++ < 10) {
      if (current.item.parentId2) { rootDealId = current.item.parentId2; break; }
      const parent = await findParent(current.entityTypeId, current.item);
      if (!parent) break;
      if (parent.type === 'deal') { rootDealId = parent.id; break; }
      const parentItem = await getItem(parent.type, parent.id);
      if (!parentItem) break;
      current = { entityTypeId: parent.type, item: parentItem };
    }

    if (!rootDealId) return res.status(404).json({ ok: false, error: 'Родительская сделка не найдена' });

    const tree = await buildTree('deal', rootDealId);
    res.json({ ok: true, tree, focusEntityTypeId: entityTypeId, focusItemId: itemId });
  } catch(err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /webhook/bitrix-update — outbound webhook handler ───────────────────
// NOTE: mounted separately without requireAuth (Bitrix calls this directly)
async function handleBitrixWebhook(req, res) {
  try {
    // Verify token
    const token = req.body?.auth?.application_token || req.query?.auth?.application_token;
    if (WEBHOOK_TOKEN && token !== WEBHOOK_TOKEN) {
      console.warn('Webhook: invalid token');
      return res.status(200).send('ignored'); // respond 200 anyway to avoid retries
    }

    const event = req.body?.event;
    const data = req.body?.data;

    // ── Deal events (for the Статистика module's local cache) ──────────────
    if (['ONCRMDEALADD', 'ONCRMDEALUPDATE'].includes(event) && data) {
      const dealId = parseInt(data.FIELDS?.ID || data.ID);
      if (dealId) {
        res.status(200).send('ok');
        try {
          const { syncOneDeal } = require('../stats-sync');
          await syncOneDeal(dealId);
        } catch (e) {
          console.error('stats-sync webhook error:', e.message);
        }
        try {
          const { syncOneDeal: syncOneOperationalDeal } = require('../operational-sync');
          await syncOneOperationalDeal(dealId);
        } catch (e) {
          console.error('operational-sync webhook error:', e.message);
        }
        // Встреча (сделка воронки 4) → планировщик (type=meeting)
        try {
          const dr = await b24('crm.item.get', { entityTypeId: 2, id: dealId });
          const ditem = dr && dr.result && dr.result.item;
          if (ditem && String(ditem.categoryId) === '4') await syncMeetingEvent(ditem, dealId);
        } catch (e) { console.error('meeting planner sync:', e.message); }
        return;
      }
    }

    // ── Deal deletion — убрать сделку из зеркал Статистики/Контрактов/Операционки ─
    if (event === 'ONCRMDEALDELETE' && data) {
      const dealId = parseInt(data.FIELDS?.ID || data.ID);
      if (dealId) {
        res.status(200).send('ok');
        try { const { deleteDeal } = require('../stats-sync'); await deleteDeal(dealId); }
        catch (e) { console.error('stats delete webhook error:', e.message); }
        try { const { deleteDeal: delOp } = require('../operational-sync'); await delOp(dealId); }
        catch (e) { console.error('operational delete webhook error:', e.message); }
        console.log(`🗑️ Сделка #${dealId} удалена из зеркал (вебхук ONCRMDEALDELETE)`);
        return;
      }
    }

    if (!['ONCRMDYNAMICITEMUPDATE','ONCRMDYNAMICITEMADD'].includes(event) || !data) {
      return res.status(200).send('ok');
    }

    const fields = data.FIELDS || {};
    const entityTypeId = parseInt(fields.ENTITY_TYPE_ID || data.ENTITY_TYPE_ID);
    const itemId = parseInt(fields.ID || data.ID);
    if (!entityTypeId || !itemId) return res.status(200).send('ok');

    // Respond immediately, process async
    res.status(200).send('ok');

    const item = await getItem(entityTypeId, itemId);
    if (!item) return;

    // ── Case 0: Sync into the planner (Заявка на сервис only) ──────────────
    if (entityTypeId === 1058) {
      await syncPlannerEvent(item, itemId);
      try { await serviceStats.upsertFromItem(item, itemId); } catch (e) {} // зеркало статистики
      // Авто-создание закупки из завершённого «подбора допов» (best-effort, с дедупом)
      try { const { autoCreateFromService } = require('../procurement-calc'); await autoCreateFromService(itemId); }
      catch (e) { console.error('procurement auto-create error:', e.message); }
    }
    // ── Отпуск (1108) → планировщик (type=leave) ───────────────────────────
    if (entityTypeId === 1108) {
      try { await syncLeaveEvent(item, itemId); } catch (e) { console.error('leave planner sync:', e.message); }
    }
    // ── Командировка (1074) → планировщик (дедуп по parentId1058) ───────────
    if (entityTypeId === 1074) {
      try { await syncTripCommand(item, itemId); } catch (e) { console.error('trip command planner sync:', e.message); }
      try { if (item.parentId1058) await serviceStats.markTrip(item.parentId1058, STATS_TRIP_APPROVED.has(item.stageId)); } catch (e) {} // зеркало статистики
    }

    // ── Case 1: Engineer assigned (only for Заявка на сервис, 1058) ────────────
    if (entityTypeId === 1058) {
      const assignedById = parseInt(item.assignedById);
      const isCoordinator = COORDINATOR_IDS.has(assignedById);
      const prevAssigned = notifiedAssignments.get(itemId);

      if (!isCoordinator && assignedById && prevAssigned !== assignedById) {
        notifiedAssignments.set(itemId, assignedById);
        // Only notify if this is a genuine engineer assignment (not first load with same value)
        if (prevAssigned !== undefined) {
          const mgr = await getRootDealManager(entityTypeId, item);
          if (mgr && mgr.managerId) {
            const itemTitle = item.title || '';
            const itemUrl = `https://crm.prolabsupport.kz/crm/type/1058/details/${itemId}/`;
            const dealUrl = mgr.dealId ? `https://crm.prolabsupport.kz/crm/deal/details/${mgr.dealId}/` : null;
            // Resolve engineer name via Bitrix user.get would need extra call; use a lightweight map fallback
            const engineerName = USERS[assignedById] || `Пользователь #${assignedById}`;
            await notifyEngineerAssigned(mgr.managerId, {
              itemId, title: itemTitle, engineerName, url: itemUrl, dealUrl,
            });
          }
        }
      } else if (prevAssigned === undefined) {
        // First time seeing this item — just record without notifying
        notifiedAssignments.set(itemId, assignedById);
      }
    }

    // ── Case 2: Process completion (Заявка на сервис, Закупки, Логистика) ──────
    if (TRACKED_FOR_COMPLETION.has(entityTypeId)) {
      const final = await isFinalStage(entityTypeId, item.categoryId, item.stageId);
      if (final) {
        const completionKey = `${entityTypeId}:${itemId}:${item.stageId}`;
        if (!notifiedCompletions.has(completionKey)) {
          notifiedCompletions.add(completionKey);

          const stageInfo = await resolveStageName(entityTypeId, item.categoryId, item.stageId);
          const typeName = SMART_TYPES[entityTypeId]?.name || `Тип ${entityTypeId}`;
          const itemUrl = `https://crm.prolabsupport.kz/crm/type/${entityTypeId}/details/${itemId}/`;

          const mgr = await getRootDealManager(entityTypeId, item);
          if (mgr && mgr.managerId) {
            const dealUrl = mgr.dealId ? `https://crm.prolabsupport.kz/crm/deal/details/${mgr.dealId}/` : null;
            await notifyProcessCompleted(mgr.managerId, {
              entityName: typeName, entityTypeId, itemId,
              title: item.title, stageName: stageInfo.name,
              url: itemUrl, dealUrl, dealId: mgr.dealId,
            });
          }
        }
      }
    }

    // ── Existing: notify Руководство group on any final-stage completion (kept) ─
    const final = await isFinalStage(entityTypeId, item.categoryId, item.stageId);
    if (!final) return;

    const parent = await findParent(entityTypeId, item);
    if (!parent) return;

    const typeName = SMART_TYPES[entityTypeId]?.name || `Тип ${entityTypeId}`;
    const itemTitle = (item.title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `#${itemId}`;
    const itemUrl = `https://crm.prolabsupport.kz/crm/type/${entityTypeId}/details/${itemId}/`;

    let parentUrl, parentLabel;
    if (parent.type === 'deal') {
      parentUrl = `https://crm.prolabsupport.kz/crm/deal/details/${parent.id}/`;
      parentLabel = `Сделка #${parent.id}`;
    } else {
      const parentTypeName = SMART_TYPES[parent.type]?.name || `Тип ${parent.type}`;
      parentUrl = `https://crm.prolabsupport.kz/crm/type/${parent.type}/details/${parent.id}/`;
      parentLabel = `${parentTypeName} #${parent.id}`;
    }

    await tgMgt(
      `✅ <b>Завершён дочерний процесс</b>\n` +
      `📋 ${typeName} #${itemId}: ${itemTitle}\n` +
      `🔗 <a href="${itemUrl}">Открыть процесс</a>\n\n` +
      `⬆️ Родитель: ${parentLabel}\n` +
      `🔗 <a href="${parentUrl}">Открыть родителя</a>`
    );

  } catch(err) {
    console.error('Webhook handler error:', err.message);
  }
}

// Разовая актуализация планировщика по всем заявкам 1058 (админ): перекрасить
// подготовительные (prep) и убрать завершённые. force → без пропуска по хэшу.
// Долгая операция — запускаем в фоне, отвечаем сразу.
router.post('/reconcile-planner', requireAuth(), async (req, res) => {
  if (!isAdminLike(req.user.role)) return res.status(403).json({ ok: false, error: 'Только админ' });
  reconcileAllPlannerEvents(true).catch(e => console.error('reconcile-planner (force):', e.message));
  res.json({ ok: true, started: true });
});

// Точечная сверка планировщика по списку заявок 1058 (админ). Полный путь
// (без пропуска по хэшу) → гарантированно перепроставляет prep/убирает
// завершённые на указанных заявках, не дожидаясь полного прохода по всем.
// Тело: { ids:[1858,1859,...] }. Возвращает результат по каждой заявке —
// одновременно и бэкофилл, и диагностика (видно ok/removed/ошибку).
router.post('/sync-items', requireAuth(), express.json(), async (req, res) => {
  if (!isAdminLike(req.user.role)) return res.status(403).json({ ok: false, error: 'Только админ' });
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'Нужен ids:[...]' });
  const out = [];
  for (const id of ids) {
    try {
      const item = await getItem(1058, id);
      if (!item) { out.push({ id, error: 'не найдена' }); continue; }
      const r = await syncPlannerEvent(item, id); // полный путь, без knownHashes
      out.push({ id, result: r || { ok: true } });
    } catch (e) { out.push({ id, error: e.message }); }
  }
  res.json({ ok: true, out });
});

module.exports = { router, handleBitrixWebhook, syncPlannerEvent, reconcileAllPlannerEvents };

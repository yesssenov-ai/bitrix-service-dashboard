const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
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

setMgrNotifyPool(pool);

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

  const ready = engineerId && startRaw && endRaw && svcIds.length && companyId;
  if (!ready) {
    // Required data isn't (or is no longer) complete — remove any previously
    // synced event for this item so the planner doesn't show a stale job.
    try { await pool.query('DELETE FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1', [itemId]); }
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

  const fieldsObj = { df1: areaLabel, df2: location, df3: svcLabel, df4: instrLabel };
  const clientsArr = clientName ? [{ name: clientName, type: '' }] : [];
  const startLocal = fmtLocalNaive(sDate), endLocal = fmtLocalNaive(eDate);
  const title = item.title || '';

  const client = await pool.connect();
  let notifyKind = null; // null | 'new' | array of change reasons like ['engineer','dates']
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, resource, bitrix_sync_hash,
        to_char(start_at AT TIME ZONE '${PLANNER_TZ}', 'YYYY-MM-DD') AS start_date_old,
        to_char(end_at AT TIME ZONE '${PLANNER_TZ}', 'YYYY-MM-DD') AS end_date_old
       FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1`, [itemId]
    );
    const newHash = computeSyncHash(engineerId, startLocal.slice(0, 10), endLocal.slice(0, 10));

    if (rows.length && rows[0].bitrix_sync_hash === newHash) {
      // Bitrix's current engineer+dates match what we last recorded — this
      // is either an echo of our own outbound push, or an unrelated field
      // changed on the request. Either way, don't touch resource/dates/
      // confirmed (a newer local planner edit may be mid-flight, and this
      // was overwriting a manual "Подтверждено" uncheck on every sync pass);
      // just refresh the read-only fields.
      await client.query(
        `UPDATE ticketsmodule_planner_events SET title=$1, fields=$2, clients=$3, updated_at=NOW() WHERE id=$4`,
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

  if (notifyKind && !opts.silent) {
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
  return { ok: true };
}

// ── Periodic reconciliation sweep ───────────────────────────────────────────
// Webhooks are inherently best-effort (Bitrix delivery hiccups, a restart at
// the wrong moment, etc.) — this walks every Заявка на сервис and re-runs the
// exact same sync logic, so any missed webhook is caught and fixed here
// instead of silently staying wrong until someone notices.
async function reconcileAllPlannerEvents() {
  let start = 0, checked = 0, errors = 0;
  const failedIds = [];
  while (true) {
    let items, next;
    try {
      const resp = await b24('crm.item.list', { entityTypeId: 1058, select: ['*', 'uf_*'], order: { id: 'asc' }, start });
      items = resp.result?.items || [];
      next = resp.next;
    } catch (e) {
      console.error('reconcileAllPlannerEvents: crm.item.list failed:', e.message);
      break;
    }
    if (!items.length) break;
    for (const item of items) {
      checked++;
      const result = await syncPlannerEvent(item, item.id, { silent: true });
      if (result && result.ok === false) { errors++; failedIds.push(item.id); }
    }
    if (next === undefined || items.length < 50) break;
    start = next;
  }
  if (errors > 0) {
    try {
      await tgOps(`⚠️ Плановая сверка планировщика: ${errors} из ${checked} заявок не удалось синхронизировать (ID: ${failedIds.slice(0,20).join(', ')}${failedIds.length>20?'…':''})`);
    } catch (e) {}
  }
  console.log(`Planner reconciliation: checked ${checked}, ${errors} error(s)`);
  return { checked, errors };
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
  const managers = Object.entries(USERS)
    .filter(([id]) => Number(id) > 10)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  res.json({ ok: true, managers });
});

// ── GET /relations/manager-deals/:managerId ───────────────────────────────────
router.get('/manager-deals/:managerId', requireAuth(), async (req, res) => {
  try {
    const managerId = parseInt(req.params.managerId);
    if (!managerId) return res.status(400).json({ ok: false, error: 'Invalid manager ID' });
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

module.exports = { router, handleBitrixWebhook, syncPlannerEvent, reconcileAllPlannerEvents };

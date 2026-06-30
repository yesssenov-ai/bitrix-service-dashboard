const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const {
  SMART_TYPES, getItem, getDeal, buildTree, searchDeals, findParent, isFinalStage, WEBHOOK_TOKEN,
  getDealsByManager, SALES_CATEGORIES, resolveStageName,
} = require('../relations');
const { tgMgt } = require('../notifications');
const { notifyProcessCompleted, notifyEngineerAssigned, setPool: setMgrNotifyPool } = require('../manager-notifications');
const { USERS } = require('../user-names');

setMgrNotifyPool(pool);

// Entity types we track for completion notifications (per user request)
const TRACKED_FOR_COMPLETION = new Set([1058, 1066, 1070]); // Заявка на сервис, Закупки, Логистика

// Coordinator IDs whose assignment does NOT count as "engineer assigned"
const COORDINATOR_IDS = new Set([26, 79]);

// In-memory cache to avoid duplicate notifications for same item+stage
const notifiedCompletions = new Set();
const notifiedAssignments = new Map(); // itemId -> last assignedById seen

// ── Resolve the responsible manager (root deal's ASSIGNED_BY_ID) ──────────────

async function getRootDealManager(entityTypeId, item) {
  // Walk up to the root deal
  let current = { entityTypeId, item };
  let safety = 0;
  while (safety++ < 10) {
    if (current.item.parentId2) {
      const deal = await getDeal(current.item.parentId2);
      if (!deal) return null;
      return { managerId: parseInt(deal.ASSIGNED_BY_ID), dealId: current.item.parentId2, deal };
    }
    const parent = await findParent(current.entityTypeId, current.item);
    if (!parent) return null;
    if (parent.type === 'deal') {
      const deal = await getDeal(parent.id);
      if (!deal) return null;
      return { managerId: parseInt(deal.ASSIGNED_BY_ID), dealId: parent.id, deal };
    }
    const parentItem = await getItem(parent.type, parent.id);
    if (!parentItem) return null;
    current = { entityTypeId: parent.type, item: parentItem };
  }
  return null;
}


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
    if (event !== 'ONCRMDYNAMICITEMUPDATE' || !data) {
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

module.exports = { router, handleBitrixWebhook };

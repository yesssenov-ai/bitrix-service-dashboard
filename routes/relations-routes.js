const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth');
const {
  SMART_TYPES, getItem, buildTree, searchDeals, findParent, isFinalStage, WEBHOOK_TOKEN,
} = require('../relations');
const { tgMgt } = require('../notifications');

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

    // Fetch full item to check stage
    const item = await getItem(entityTypeId, itemId);
    if (!item) return;

    const final = await isFinalStage(entityTypeId, item.categoryId, item.stageId);
    if (!final) return;

    // Find parent and notify
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

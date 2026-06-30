const fetch = require('node-fetch');

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const WEBHOOK_TOKEN = process.env.BITRIX_OUTBOUND_TOKEN || '2uvfi1mfqmtwvxl6lrbovsixcikvnaqc';

// ── Known smart process types ─────────────────────────────────────────────────
const SMART_TYPES = {
  1036: { name: 'Регистрация контрактов', categoryField: null },
  1042: { name: 'Учет оборудования клиентов', categoryField: null },
  1046: { name: 'Отчет о проделанной работе', categoryField: null },
  1050: { name: 'Запланированные работы', categoryField: null },
  1058: { name: 'Заявка на сервис', categoryField: null },
  1062: { name: 'Акт выполненных работ', categoryField: null },
  1066: { name: 'Закупки', categoryField: null },
  1070: { name: 'Логистика', categoryField: null },
  1074: { name: 'Заявка на командировку', categoryField: null },
};

// Final/success stages per entity type (stageId suffix patterns to check)
const FINAL_STAGE_PATTERNS = ['SUCCESS', 'WON', 'CLOSED', '3']; // adjust per actual stage IDs found

function flattenInto(parts, obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') flattenInto(parts, item, `${key}[${i}]`);
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === 'object') {
      flattenInto(parts, v, key);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
}

async function b24call(method, params = {}) {
  const parts = [];
  flattenInto(parts, params, '');
  const url = `${BITRIX_WEBHOOK}${method}.json?${parts.join('&')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bitrix API error: ${res.status}`);
  return res.json();
}

// ── Fetch single item with all fields ─────────────────────────────────────────

async function getItem(entityTypeId, id) {
  try {
    const data = await b24call('crm.item.get', { entityTypeId, id });
    return data.result?.item || null;
  } catch(e) {
    console.error(`getItem error (type=${entityTypeId}, id=${id}):`, e.message);
    return null;
  }
}

async function getDeal(id) {
  try {
    const data = await b24call('crm.deal.get', { id });
    return data.result || null;
  } catch(e) {
    console.error(`getDeal error (id=${id}):`, e.message);
    return null;
  }
}

// ── Find children of a deal (parentId2 = dealId) ──────────────────────────────

async function findChildrenOfDeal(dealId) {
  const children = [];
  for (const [entityTypeId, info] of Object.entries(SMART_TYPES)) {
    try {
      const data = await b24call('crm.item.list', {
        entityTypeId: Number(entityTypeId),
        filter: { parentId2: dealId },
        select: ['id', 'title', 'stageId', 'createdTime', 'assignedById'],
      });
      const items = data.result?.items || [];
      for (const item of items) {
        children.push({ entityTypeId: Number(entityTypeId), entityName: info.name, ...item });
      }
    } catch(e) {
      // Type might not support this filter, skip
    }
  }
  return children;
}

// ── Find children of a smart process item (parentId{type} = itemId) ──────────

async function findChildrenOfItem(parentEntityTypeId, parentItemId) {
  const children = [];
  for (const [entityTypeId, info] of Object.entries(SMART_TYPES)) {
    if (Number(entityTypeId) === parentEntityTypeId) continue; // skip self-type
    const filterField = `parentId${parentEntityTypeId}`;
    try {
      const data = await b24call('crm.item.list', {
        entityTypeId: Number(entityTypeId),
        filter: { [filterField]: parentItemId },
        select: ['id', 'title', 'stageId', 'createdTime', 'assignedById'],
      });
      const items = data.result?.items || [];
      for (const item of items) {
        children.push({ entityTypeId: Number(entityTypeId), entityName: info.name, ...item });
      }
    } catch(e) {
      // skip
    }
  }
  return children;
}

// ── Build full tree recursively ───────────────────────────────────────────────

async function buildTree(rootType, rootId, depth = 0, maxDepth = 6, visited = new Set()) {
  const key = `${rootType}:${rootId}`;
  if (visited.has(key) || depth > maxDepth) return null;
  visited.add(key);

  let node;
  if (rootType === 'deal') {
    const deal = await getDeal(rootId);
    if (!deal) return null;
    node = {
      type: 'deal',
      entityTypeId: 'deal',
      id: rootId,
      title: deal.TITLE || `Сделка #${rootId}`,
      stageId: deal.STAGE_ID,
      categoryId: deal.CATEGORY_ID,
      opportunity: deal.OPPORTUNITY,
      url: `https://crm.prolabsupport.kz/crm/deal/details/${rootId}/`,
      children: [],
    };
    const childItems = await findChildrenOfDeal(rootId);
    for (const child of childItems) {
      const childNode = await buildTree(child.entityTypeId, child.id, depth + 1, maxDepth, visited);
      if (childNode) node.children.push(childNode);
    }
  } else {
    const item = await getItem(rootType, rootId);
    if (!item) return null;
    const info = SMART_TYPES[rootType];
    node = {
      type: 'smart',
      entityTypeId: rootType,
      entityName: info?.name || `Тип ${rootType}`,
      id: rootId,
      title: item.title || `#${rootId}`,
      stageId: item.stageId,
      categoryId: item.categoryId,
      url: `https://crm.prolabsupport.kz/crm/type/${rootType}/details/${rootId}/`,
      children: [],
    };
    const childItems = await findChildrenOfItem(rootType, rootId);
    for (const child of childItems) {
      const childNode = await buildTree(child.entityTypeId, child.id, depth + 1, maxDepth, visited);
      if (childNode) node.children.push(childNode);
    }
  }

  return node;
}

// ── Search deals by title ─────────────────────────────────────────────────────

async function searchDeals(query, limit = 20) {
  try {
    const data = await b24call('crm.deal.list', {
      filter: { '%TITLE': query },
      select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'DATE_CREATE'],
      order: { DATE_CREATE: 'DESC' },
      start: 0,
    });
    return (data.result || []).slice(0, limit);
  } catch(e) {
    console.error('searchDeals error:', e.message);
    return [];
  }
}

// ── Find parent of a smart process item (walk up) ─────────────────────────────

async function findParent(entityTypeId, item) {
  // Check parentId2 (deal parent)
  if (item.parentId2) {
    return { type: 'deal', id: item.parentId2 };
  }
  // Check parentId{type} for other smart process types
  for (const otherType of Object.keys(SMART_TYPES)) {
    const field = `parentId${otherType}`;
    if (item[field]) {
      return { type: Number(otherType), id: item[field] };
    }
  }
  return null;
}

module.exports = {
  SMART_TYPES, b24call, getItem, getDeal,
  findChildrenOfDeal, findChildrenOfItem, buildTree,
  searchDeals, findParent, WEBHOOK_TOKEN,
};

// ── Stage semantics cache (success/fail detection) ────────────────────────────

const stageSemanticsCache = new Map();

async function getStageSemantics(entityTypeId, categoryId, stageId) {
  const cacheKey = `${entityTypeId}_${categoryId}`;
  if (!stageSemanticsCache.has(cacheKey)) {
    try {
      const entityId = `DYNAMIC_${entityTypeId}_STAGE_${categoryId}`;
      const data = await b24call('crm.status.list', {
        filter: { ENTITY_ID: entityId },
        select: ['STATUS_ID', 'NAME', 'SEMANTICS'],
      });
      const map = {};
      for (const s of (data.result || [])) {
        map[s.STATUS_ID] = s.SEMANTICS; // 'P' process, 'S' success, 'F' fail
      }
      stageSemanticsCache.set(cacheKey, map);
    } catch(e) {
      console.error('getStageSemantics error:', e.message);
      stageSemanticsCache.set(cacheKey, {});
    }
  }
  const map = stageSemanticsCache.get(cacheKey);
  return map[stageId] || 'P';
}

async function isFinalStage(entityTypeId, categoryId, stageId) {
  const sem = await getStageSemantics(entityTypeId, categoryId, stageId);
  return sem === 'S' || sem === 'F';
}

module.exports.getStageSemantics = getStageSemantics;
module.exports.isFinalStage = isFinalStage;

// ── Sales pipeline filter (deals in "realization" stages) ─────────────────────

const SALES_CATEGORIES = {
  0: { name: 'Продажа инструментов', stages: ['FINAL_INVOICE','1','UC_Q9J6VV','UC_9MBFR2','2','3'] },
  1: { name: 'Продажа расходных материалов', stages: ['C1:FINAL_INVOICE','C1:1','C1:UC_3MVK90','C1:UC_3SCB5K','C1:2','C1:3'] },
  2: { name: 'Продажа услуг тренинг-центра', stages: ['C2:FINAL_INVOICE','C2:1','C2:2'] },
  3: { name: 'Продажа сервиса', stages: ['C3:FINAL_INVOICE','C3:UC_YYTFYG','C3:2'] },
};

async function getDealsByManager(assignedById) {
  const allDeals = [];
  for (const [categoryId, cfg] of Object.entries(SALES_CATEGORIES)) {
    try {
      const data = await b24call('crm.deal.list', {
        filter: {
          ASSIGNED_BY_ID: assignedById,
          CATEGORY_ID: categoryId,
          '@STAGE_ID': cfg.stages,
        },
        select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'DATE_CREATE', 'COMPANY_ID'],
        order: { DATE_CREATE: 'DESC' },
      });
      const deals = (data.result || []).map(d => ({
        id: d.ID, title: d.TITLE, stageId: d.STAGE_ID,
        categoryId: Number(categoryId), categoryName: cfg.name,
        opportunity: d.OPPORTUNITY, dateCreate: d.DATE_CREATE, companyId: d.COMPANY_ID,
      }));
      allDeals.push(...deals);
    } catch(e) {
      console.error(`getDealsByManager error (category=${categoryId}):`, e.message);
    }
  }
  return allDeals.sort((a, b) => new Date(b.dateCreate) - new Date(a.dateCreate));
}

module.exports.SALES_CATEGORIES = SALES_CATEGORIES;
module.exports.getDealsByManager = getDealsByManager;

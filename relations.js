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

// ── Explicit, confirmed parent-child relations between smart process types ────
// Format: parentEntityTypeId -> [{ childEntityTypeId, filterField }]
// Only these specific links represent real business automation chains.
const EXPLICIT_RELATIONS = {
  1066: [{ childType: 1070, filterField: 'parentId1066' }],  // Закупки -> Логистика
  1058: [{ childType: 1074, filterField: 'parentId1058' }],  // Заявка на сервис -> Командировка
  1050: [{ childType: 1058, filterField: 'parentId1050' }],  // Запланированные работы -> Заявка на сервис
};

// Types confirmed to be LEAVES (never have smart-process children) —
// Bitrix24 sometimes auto-populates cross-type parentId{X} fields even without
// real business automation, so we hard-block lookups for these types.
const LEAF_TYPES = new Set([1036, 1042, 1046, 1062, 1074]);

// ── Find children of a smart process item (only via EXPLICIT_RELATIONS) ───────

async function findChildrenOfItem(parentEntityTypeId, parentItemId) {
  if (LEAF_TYPES.has(parentEntityTypeId)) return [];
  const children = [];
  const rels = EXPLICIT_RELATIONS[parentEntityTypeId];
  if (!rels) return children;

  for (const rel of rels) {
    const info = SMART_TYPES[rel.childType];
    try {
      const data = await b24call('crm.item.list', {
        entityTypeId: rel.childType,
        filter: { [rel.filterField]: parentItemId },
        select: ['id', 'title', 'stageId', 'createdTime', 'assignedById'],
      });
      const items = data.result?.items || [];
      for (const item of items) {
        children.push({ entityTypeId: rel.childType, entityName: info?.name || `Тип ${rel.childType}`, ...item });
      }
    } catch(e) {
      // skip
    }
  }
  return children;
}

// ── Stage name resolver (human-readable names instead of raw STATUS_ID) ───────

const stageNameCache = new Map();

async function getStageNames(entityTypeOrDeal, categoryId) {
  const cacheKey = entityTypeOrDeal === 'deal' ? `deal_${categoryId}` : `${entityTypeOrDeal}_${categoryId}`;
  if (!stageNameCache.has(cacheKey)) {
    try {
      const entityId = entityTypeOrDeal === 'deal'
        ? (Number(categoryId) === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`)
        : `DYNAMIC_${entityTypeOrDeal}_STAGE_${categoryId}`;
      const data = await b24call('crm.status.list', {
        filter: { ENTITY_ID: entityId },
        select: ['STATUS_ID', 'NAME', 'COLOR', 'SEMANTICS'],
      });
      const map = {};
      for (const s of (data.result || [])) {
        map[s.STATUS_ID] = { name: s.NAME, color: s.COLOR, semantics: s.SEMANTICS };
      }
      stageNameCache.set(cacheKey, map);
    } catch(e) {
      console.error('getStageNames error:', e.message);
      stageNameCache.set(cacheKey, {});
    }
  }
  return stageNameCache.get(cacheKey);
}

async function resolveStageName(entityTypeOrDeal, categoryId, stageId) {
  const map = await getStageNames(entityTypeOrDeal, categoryId);
  return map[stageId] || { name: stageId, color: '#8a8886', semantics: null };
}

async function buildTree(rootType, rootId, depth = 0, maxDepth = 6, visited = new Set()) {
  const key = `${rootType}:${rootId}`;
  if (visited.has(key) || depth > maxDepth) return null;
  visited.add(key);

  let node;
  if (rootType === 'deal') {
    const deal = await getDeal(rootId);
    if (!deal) return null;
    const stageInfo = await resolveStageName('deal', deal.CATEGORY_ID, deal.STAGE_ID);
    node = {
      type: 'deal',
      entityTypeId: 'deal',
      id: rootId,
      title: deal.TITLE || `Сделка #${rootId}`,
      stageId: deal.STAGE_ID,
      stageName: stageInfo.name,
      stageColor: stageInfo.color,
      stageSemantics: stageInfo.semantics,
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
    const stageInfo = await resolveStageName(rootType, item.categoryId, item.stageId);
    node = {
      type: 'smart',
      entityTypeId: rootType,
      entityName: info?.name || `Тип ${rootType}`,
      id: rootId,
      title: item.title || `#${rootId}`,
      stageId: item.stageId,
      stageName: stageInfo.name,
      stageColor: stageInfo.color,
      stageSemantics: stageInfo.semantics,
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

// ── Reverse map: for a given child type, which type+field is its REAL explicit parent ──
const EXPLICIT_PARENT_OF = {
  1070: { parentType: 1066, field: 'parentId1066' }, // Логистика <- Закупки
  1074: { parentType: 1058, field: 'parentId1058' }, // Командировка <- Заявка на сервис
  1058: { parentType: 1050, field: 'parentId1050' }, // Заявка на сервис <- Запланированные работы (if present)
};

// ── Find parent of a smart process item (only via confirmed explicit relations or deal) ──

async function findParent(entityTypeId, item) {
  // Check explicit smart-process parent first (more specific than deal)
  const rel = EXPLICIT_PARENT_OF[entityTypeId];
  if (rel && item[rel.field]) {
    return { type: rel.parentType, id: item[rel.field] };
  }
  // Fall back to deal parent
  if (item.parentId2) {
    return { type: 'deal', id: item.parentId2 };
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
      // Resolve stage names once per category (cached)
      const stageMap = await getStageNames('deal', categoryId);
      const deals = (data.result || []).map(d => ({
        id: d.ID, title: d.TITLE, stageId: d.STAGE_ID,
        stageName: stageMap[d.STAGE_ID]?.name || d.STAGE_ID,
        stageColor: stageMap[d.STAGE_ID]?.color || '#8a8886',
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

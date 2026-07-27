const { getItem, findParent } = require('./relations');
const { b24 } = require('./bitrix');

// "Тип оказываемых услуг (УС)" (ufCrm8_1744300223) — full id→label map,
// confirmed against the live field editor (crm.item.fields doesn't expose
// choices for iblock_element fields, so this is hand-verified, not fetched).
const SERVICE_TYPE_MAP = {
  103:'Установка', 104:'Техническое обслуживание', 105:'Диагностика', 106:'Ремонт',
  107:'Методическое сопровождение', 108:'Обучение сервисного отдела', 109:'Обучение ТЦ',
  110:'Квалификация', 111:'Подбор дополнительного оборудования',
  112:'Подбор расходки / запасных частей', 113:'Претензия',
  114:'Другое', 402:'Подготовка документов', 619:'Заявка клиента',
};

// "Название прибора." (ufCrmPribor) is a real Bitrix enumeration field, so
// its choices ARE fetchable via crm.item.fields — cache them instead of
// hardcoding 300+ entries that Bitrix can add to at any time.
let priborCache = null, priborCacheAt = 0;
async function getPriborMap() {
  if (priborCache && Date.now() - priborCacheAt < 60 * 60 * 1000) return priborCache;
  try {
    const { result } = await b24('crm.item.fields', { entityTypeId: 1058 });
    const items = result?.fields?.ufCrmPribor?.items || [];
    const map = {};
    items.forEach(i => { map[i.ID] = i.VALUE; });
    priborCache = map; priborCacheAt = Date.now();
  } catch (e) {
    console.error('getPriborMap error:', e.message);
    if (!priborCache) priborCache = {};
  }
  return priborCache;
}

const companyNameCache = new Map(); // companyId -> {name, at}
async function getCompanyName(companyId) {
  const cached = companyNameCache.get(companyId);
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.name;
  try {
    const { result } = await b24('crm.company.get', { id: companyId });
    const name = result?.TITLE || '';
    companyNameCache.set(companyId, { name, at: Date.now() });
    return name;
  } catch (e) {
    console.error('getCompanyName error:', e.message);
    return '';
  }
}

// Best-effort resolver for "crm" type link fields (e.g. Контракт), which
// Bitrix stores as a prefixed reference like "D_123" (deal) or
// "DYNAMIC_<entityTypeId>_<id>" (smart-process item). Falls back to the raw
// value if the format isn't one we recognize.
async function resolveCrmFieldLabel(crmValue) {
  if (!crmValue) return '';
  const dynMatch = String(crmValue).match(/^DYNAMIC_(\d+)_(\d+)$/);
  if (dynMatch) {
    try {
      const { result } = await b24('crm.item.get', { entityTypeId: parseInt(dynMatch[1], 10), id: parseInt(dynMatch[2], 10) });
      return result?.item?.title || String(crmValue);
    } catch (e) { return String(crmValue); }
  }
  const dealMatch = String(crmValue).match(/^D_(\d+)$/);
  if (dealMatch) {
    try {
      const { result } = await b24('crm.deal.get', { id: parseInt(dealMatch[1], 10) });
      return result?.TITLE || String(crmValue);
    } catch (e) { return String(crmValue); }
  }
  return String(crmValue);
}

// Contract, resolved by walking the parent chain to "Регистрация
// контрактов" (1036) — more reliable than the item's own often-empty field.
// Cached per item for 24h since contract info almost never changes.
const contractCache = new Map(); // itemId -> {label, at}
async function getContractFromChain(entityTypeId, item) {
  const cached = contractCache.get(item.id);
  if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) return cached.label;

  let current = { entityTypeId, item };
  let safety = 0;
  let label = '';
  while (safety++ < 10) {
    if (current.item.parentId1036) {
      try {
        const { result } = await b24('crm.item.get', { entityTypeId: 1036, id: current.item.parentId1036 });
        label = result?.item?.title || '';
      } catch (e) { label = ''; }
      break;
    }
    if (current.item.parentId2) break; // reached the deal, no contract link found along the way
    const parent = await findParent(current.entityTypeId, current.item);
    if (!parent || parent.type === 'deal') break;
    const parentItem = await getItem(parent.type, parent.id);
    if (!parentItem) break;
    current = { entityTypeId: parent.type, item: parentItem };
  }
  contractCache.set(item.id, { label, at: Date.now() });
  return label;
}

// Resolve the responsible sales manager: walk up to the root deal, return
// its ASSIGNED_BY_ID.
async function getRootDealManager(entityTypeId, item) {
  const { getDeal } = require('./relations');
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

function fmtDateOnly(d) {
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}
function fmtLocalNaive(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// If someone deletes a Bitrix-linked event from the planner, Bitrix itself
// is untouched — the item will be recreated the next time it's synced
// (sweep or webhook), since the assignment is still valid there. That's
// expected (the planner warns about it), but it shouldn't look like a brand
// new assignment and re-notify everyone — mark it here for a grace window.
const recentlyDeleted = new Map(); // bitrixItemId -> deletedAt
const RECENTLY_DELETED_WINDOW_MS = 20 * 60 * 1000; // 20 minutes
function markRecentlyDeleted(bitrixItemId) {
  recentlyDeleted.set(bitrixItemId, Date.now());
}
function wasRecentlyDeleted(bitrixItemId) {
  const at = recentlyDeleted.get(bitrixItemId);
  if (at === undefined) return false;
  if (Date.now() - at > RECENTLY_DELETED_WINDOW_MS) { recentlyDeleted.delete(bitrixItemId); return false; }
  return true;
}

// "Город / Область / Страна (УС)" (ufCrm8_1732855428) — full id→label map,
// hand-verified against the live field editor (iblock_element fields aren't
// exposed via crm.item.fields the way real enumerations are).
const AREA_MAP = {
  47:'Абайская', 64:'Азербайджан', 48:'Акмолинская', 49:'Актюбинская', 50:'Алматинская',
  44:'Алматы', 45:'Астана', 51:'Атырауская', 52:'ВКО', 654:'Другое', 53:'Жамбылская',
  54:'Жетысуская', 55:'ЗКО', 56:'Карагандинская', 57:'Костанайская', 58:'Кызылординская',
  65:'Кыргызстан', 59:'Мангистауская', 66:'Монголия', 60:'Павлодарская', 61:'СКО',
  67:'Таджикистан', 62:'Туркестанская', 68:'Туркменистан', 69:'Узбекистан',
  63:'Ультыауская', 46:'Шымкент',
};

module.exports = {
  SERVICE_TYPE_MAP, AREA_MAP, getPriborMap, getCompanyName, resolveCrmFieldLabel,
  getContractFromChain, getRootDealManager, fmtDateOnly, fmtLocalNaive,
  markRecentlyDeleted, wasRecentlyDeleted,
};

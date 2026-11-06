// Общий кэш активных сервисных заявок (смарт-процесс 1058). Нужен, чтобы поиск и
// утренний дайджест не дёргали Bitrix на каждый запрос/каждого пользователя:
// один фоновый дозапрос с TTL, затем выборки из памяти.
// Константы продублированы из server.js (там авторитетная копия enrichItem) —
// значения стабильные; при изменении стадий синхронизировать оба места.
const { b24 } = require('./bitrix');
let USERS = {}, COORDINATORS = new Set();
try { const c = require('./constants'); USERS = c.USERS; COORDINATORS = c.COORDINATORS; } catch (e) { /* в тестах/без БД */ }

const ENTITY_TYPE_ID = 1058, CATEGORY_ID = 11;
const STAGES = {
  'DT1058_11:UC_N8RQ0V': { name: 'Заявки клиентов', color: '#468ee5', active: true },
  'DT1058_11:NEW': { name: 'Необработанные', color: '#22B9FF', active: true },
  'DT1058_11:PREPARATION': { name: 'Досбор / Назначение', color: '#88B9FF', active: true },
  'DT1058_11:CLIENT': { name: 'Заявка в работе', color: '#10e5fc', active: true },
  'DT1058_11:1': { name: 'Срочная в работе', color: '#FF6B35', active: true },
  'DT1058_11:2': { name: 'Заявка на обучение', color: '#9B59B6', active: true },
  'DT1058_11:3': { name: 'Заявка исполнена', color: '#55D0E0', active: true },
  'DT1058_11:4': { name: 'Претензия', color: '#FF5752', active: true },
  'DT1058_11:SUCCESS': { name: 'Заявка закрыта', color: '#00C851', active: false },
  'DT1058_11:FAIL': { name: 'Заявка отменена', color: '#ff4444', active: false },
};
const ACTIVE_STAGE_IDS = Object.entries(STAGES).filter(([, v]) => v.active).map(([k]) => k);
const COORDINATOR_STAGES = new Set(['DT1058_11:NEW', 'DT1058_11:PREPARATION']);
const URGENCY_MAP = { '1809': 'Срочная', '1810': 'Не срочная', '1811': 'Обучение ТЦ' };
const OVERDUE_FIELD = 'ufCrm8_1732856215147', OVERDUE_VAL = '1807';
const URGENCY_FIELD = 'ufCrm8_1732856252874';

function enrich(t) {
  const uid = t.assignedById;
  const isCoordUser = COORDINATORS && COORDINATORS.has ? COORDINATORS.has(uid) : false;
  const isCoordStage = COORDINATOR_STAGES.has(t.stageId);
  return {
    id: t.id,
    title: t.title || '—',
    stageId: t.stageId,
    stageName: (STAGES[t.stageId] && STAGES[t.stageId].name) || t.stageId,
    stageColor: (STAGES[t.stageId] && STAGES[t.stageId].color) || '#888',
    isActive: STAGES[t.stageId] ? STAGES[t.stageId].active : true,
    isOverdue: t[OVERDUE_FIELD] === OVERDUE_VAL,
    urgency: URGENCY_MAP[t[URGENCY_FIELD]] || null,
    assignedById: uid != null ? Number(uid) : null,
    engineer: (!isCoordUser && !isCoordStage) ? (USERS[uid] || null) : null,
    createdTime: t.createdTime || null,
    daysOnStage: t.movedTime ? Math.floor((Date.now() - new Date(t.movedTime)) / 86400000) : null,
    bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/details/${t.id}/`,
  };
}

let cache = { at: 0, data: [] };
const TTL_MS = 3 * 60 * 1000;

async function getActiveTickets(force) {
  if (!force && Date.now() - cache.at < TTL_MS && cache.data.length) return cache.data;
  let items = [], start = 0, total = Infinity;
  while (items.length < Math.min(total, 500)) {
    const data = await b24('crm.item.list', {
      entityTypeId: ENTITY_TYPE_ID,
      filter: { categoryId: CATEGORY_ID, stageId: ACTIVE_STAGE_IDS },
      select: ['id', 'title', 'stageId', 'createdTime', 'assignedById', 'movedTime', OVERDUE_FIELD, URGENCY_FIELD],
      order: { createdTime: 'DESC' }, start,
    });
    const batch = (data && data.result && data.result.items) || [];
    if (!batch.length) break;
    items = items.concat(batch);
    total = (data && data.total) != null ? data.total : items.length;
    start = items.length;
    if (!data || !data.next || items.length >= total) break;
  }
  cache = { at: Date.now(), data: items.map(enrich) };
  return cache.data;
}

// Заявки, назначенные на сотрудника (по bitrix_user_id). Активные.
async function ticketsForBid(bid) {
  if (!bid) return [];
  const all = await getActiveTickets();
  const n = Number(bid);
  return all.filter(t => t.assignedById === n);
}

// Поиск активных заявок по подстроке в названии (для глобального поиска).
async function searchTickets(query, limit) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const idNum = /^\d+$/.test(q) ? Number(q) : null;
  const all = await getActiveTickets();
  const hit = all.filter(t => (t.title || '').toLowerCase().includes(q) || (idNum != null && Number(t.id) === idNum));
  return hit.slice(0, limit || 6);
}

module.exports = { getActiveTickets, ticketsForBid, searchTickets, STAGES };

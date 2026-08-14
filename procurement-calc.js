// Модуль «Закуп доп оборудования».
// Дашборд менеджера склада создаёт и ведёт элементы смарта «Закупки» (1066,
// категория 13 «Общая»). Здесь: карта полей 1066, динамическая мета для формы
// (стадии + справочники прямо из Битрикса, без хардкода изменчивых ID), поиск
// сделок для привязки, и (в следующей фазе) create/update/move.
const { b24 } = require('./bitrix');
const { pool } = require('./auth');

const ENTITY = 1066;         // смарт «Закупки»
const CATEGORY = 13;         // единственная категория «Общая»
const TAG_PREFIX = 'PLS-DOP'; // метка наших заявок в xmlId элемента 1066

// ── Коды полей 1066 (из разведки crm.item.fields) ───────────────────────────
const F = {
  title: 'title',
  deal: 'parentId2',
  company: 'companyId',
  contact: 'contactId',
  assigned: 'assignedById',
  source: 'sourceId',
  stage: 'stageId',
  opportunity: 'opportunity',
  currency: 'currencyId',
  // пользовательские
  vidZakupki: 'ufCrm10_1732858256',        // «Вид закупки (УС)» — iblock, ОБЯЗАТЕЛЬНОЕ
  typeKP: 'ufCrm10_1762493468678',         // «Тип КП / Договора» — enum
  proizvoditel: 'ufCrmProizvoditel',       // enum[]
  pribor: 'ufCrmPribor',                   // enum[]
  ustanovka: 'ufCrm10_1732858371116',      // «Требуется установка» — enum
  oplataPostavshikam: 'ufCrm10_1744195840932', // «Условия оплаты поставщикам» — enum
  needKztin: 'ufCrm10_1785411029',         // «Нужен KZTIN» — enum
  kztin: 'ufCrm10_1785411152',             // string
  po: 'ufCrm10_1763536157575',             // «Номер PO»
  serial: 'ufCrm10_1732858425650',         // «Серийный номер прибора» string[]
  cityCountry: 'ufCrm10_1764043678827',    // «Город / Область / Страна»
  comment: 'ufCrm10_1733301399035',        // «Комментарий»
  // согласование оплат (фаза 2)
  preApprove: 'ufCrm10_1732858784451',     // «Согласование предоплаты» enum
  preApproveDate: 'ufCrm10_1732858792730',
  preApprover: 'ufCrm10_1786080599',       // «Утверждающий» employee
  preApproveComment: 'ufCrm10_1786082152',
  postApprove: 'ufCrm10_1732858840075',    // «Согласование постоплаты» enum
  postApproveDate: 'ufCrm10_1732858849124',
  postApprover: 'ufCrm10_1786358727',
  postApproveComment: 'ufCrm10_1786358780',
};

// ── Процесс дашборда: 7 шагов ↔ реальные стадии 1066 ────────────────────────
const FLOW = [
  { key: 'new',      label: 'Новая заявка',           bitrix: 'DT1066_13:NEW' },
  { key: 'invoice',  label: 'Запрос счета на оплату',  bitrix: 'DT1066_13:PREPARATION' },
  { key: 'contract', label: 'Договор',                 bitrix: 'DT1066_13:CLIENT' },
  { key: 'approve',  label: 'Согласование закупки',    bitrix: 'DT1066_13:1' },
  { key: 'payment',  label: 'Оплата закупки',          bitrix: 'DT1066_13:2' },
  { key: 'waiting',  label: 'Ожидание товара',         bitrix: 'DT1066_13:UC_QO83IP' },
  { key: 'received', label: 'Товар принят',            bitrix: 'DT1066_13:SUCCESS' },
];
const STAGE_TO_STEP = {}; FLOW.forEach((s, i) => { STAGE_TO_STEP[s.bitrix] = i; });
const stepIndexForStage = stageId => (STAGE_TO_STEP[stageId] != null ? STAGE_TO_STEP[stageId] : -1);

// Резерв значений «Вид закупки (УС)» (iblock 1066) на случай, если у вебхука нет
// права на lists.element.get. ID — реальные элементы списка, в Битрикс садится
// именно выбранный. Основной источник — динамический fetch ниже.
const VID_ZAKUPKI_FALLBACK = [
  { id: '127', label: 'Для поставки клиенту' },
  { id: '128', label: 'Для офиса' },
  { id: '130', label: 'Для нужд тренинг-центра' },
  { id: '129', label: 'Для нужд технического отдела' },
  { id: '131', label: 'Для нужд склада' },
  { id: '132', label: 'Для нужд маркетинга' },
  { id: '133', label: 'Для гарантийной замены' },
];

// Документы 1066: [подпись, код поля file[]] — для загрузки в фазе 2.
const DOCS = [
  ['Invoice', 'ufCrm10_1763537277532'],
  ['Proforma', 'ufCrm10_1763547107682'],
  ['Packing List / Customs', 'ufCrm10_1732858448434'],
  ['Договор / Спецификация / Appendix', 'ufCrm10_1732858619051'],
  ['Техническое описание', 'ufCrm10_1763550466425'],
  ['Сравнительная таблица', 'ufCrm10_1732858456808'],
  ['Файл размещения заказа', 'ufCrm10_1732858487739'],
  ['Подтверждение оплаты', 'ufCrm10_1744874990535'],
];

// ── Мета для формы: стадии + справочники, тянем из Битрикса, кэш 30 мин ──────
let _metaCache = null, _metaAt = 0;

function enumItems(field) {
  return (field && Array.isArray(field.items) ? field.items : []).map(i => ({ id: String(i.ID), label: i.VALUE }));
}

// Опции iblock_element-поля: сперва items (если Битрикс их отдал), иначе через
// lists.element.get по IBLOCK из settings; при отказе — пусто (форма покажет).
async function iblockOptions(field) {
  if (!field) return [];
  if (Array.isArray(field.items) && field.items.length) return enumItems(field);
  const s = field.settings || {};
  const iblockId = s.IBLOCK_ID || s.iblockId;
  const iblockType = s.IBLOCK_TYPE_ID || s.iblockTypeId || 'lists';
  if (!iblockId) return [];
  try {
    const out = []; let start = 0;
    while (true) {
      const r = await b24('lists.element.get', { IBLOCK_TYPE_ID: iblockType, IBLOCK_ID: iblockId, start });
      (r.result || []).forEach(e => out.push({ id: String(e.ID), label: e.NAME }));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
      if (out.length > 500) break;
    }
    return out;
  } catch (e) {
    console.error('iblockOptions error:', e.message);
    return [];
  }
}

async function getStages() {
  try {
    const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_1066_STAGE_${CATEGORY}` }, order: { SORT: 'ASC' } });
    return (result || []).map(s => ({ id: s.STATUS_ID, name: s.NAME, semantics: s.SEMANTICS || null }));
  } catch (e) { console.error('getStages error:', e.message); return []; }
}

async function getSources() {
  try {
    const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' }, order: { SORT: 'ASC' } });
    return (result || []).map(s => ({ id: s.STATUS_ID, name: s.NAME }));
  } catch (e) { console.error('getSources error:', e.message); return []; }
}

async function getCurrencies() {
  try {
    const { result } = await b24('crm.currency.list', {});
    const arr = (result || []).map(c => ({ id: c.CURRENCY, label: c.FULL_NAME || c.CURRENCY }));
    return arr.length ? arr : [{ id: 'KZT', label: 'Тенге' }, { id: 'USD', label: 'US Dollar' }, { id: 'EUR', label: 'Euro' }];
  } catch (e) { return [{ id: 'KZT', label: 'Тенге' }, { id: 'USD', label: 'US Dollar' }, { id: 'EUR', label: 'Euro' }]; }
}

async function getMeta(force) {
  if (_metaCache && !force && Date.now() - _metaAt < 30 * 60 * 1000) return _metaCache;
  const { result } = await b24('crm.item.fields', { entityTypeId: ENTITY });
  const fields = (result && result.fields) || {};
  const [stages, sources, currencies, vidZakupki] = await Promise.all([
    getStages(), getSources(), getCurrencies(), iblockOptions(fields[F.vidZakupki]),
  ]);
  const meta = {
    entity: ENTITY, category: CATEGORY,
    stages,
    flow: FLOW.map(s => ({ key: s.key, label: s.label, bitrix: s.bitrix })),
    sources,
    currencies,
    options: {
      vidZakupki: (vidZakupki && vidZakupki.length) ? vidZakupki : VID_ZAKUPKI_FALLBACK,
      typeKP: enumItems(fields[F.typeKP]),
      proizvoditel: enumItems(fields[F.proizvoditel]),
      pribor: enumItems(fields[F.pribor]),
      ustanovka: enumItems(fields[F.ustanovka]),
      oplataPostavshikam: enumItems(fields[F.oplataPostavshikam]),
      needKztin: enumItems(fields[F.needKztin]),
    },
    required: { vidZakupki: !!(fields[F.vidZakupki] && fields[F.vidZakupki].isRequired) },
    docs: DOCS.map(([label, code]) => ({ label, code })),
    // подсказка по «Внутреннему запросу» — id источника, если найден
    internalSourceId: (sources.find(s => /внутрен/i.test(s.name)) || {}).id || null,
  };
  _metaCache = meta; _metaAt = Date.now();
  return meta;
}

// ── Поиск сделок для привязки (по номеру/названию) ──────────────────────────
async function searchDeals(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const filter = /^\d+$/.test(q) ? { ID: q } : { '%TITLE': q };
  try {
    const { result } = await b24('crm.deal.list', {
      filter, select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'COMPANY_ID', 'OPPORTUNITY', 'CURRENCY_ID'],
      order: { ID: 'DESC' }, start: 0,
    });
    return (result || []).slice(0, 20).map(d => ({
      id: Number(d.ID), title: d.TITLE || ('Сделка #' + d.ID), stageId: d.STAGE_ID,
      categoryId: Number(d.CATEGORY_ID), companyId: d.COMPANY_ID ? Number(d.COMPANY_ID) : null,
      opportunity: parseFloat(d.OPPORTUNITY) || 0, currency: d.CURRENCY_ID || 'KZT',
    }));
  } catch (e) { console.error('searchDeals error:', e.message); return []; }
}

// ── Список наших заявок (из локальной таблицы) + актуальная стадия ───────────
function bitrixOrigin() { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return null; } }
function itemUrl(itemId) { const o = bitrixOrigin(); return o && itemId ? `${o}/crm/type/${ENTITY}/details/${itemId}/` : null; }
function dealUrl(dealId) { const o = bitrixOrigin(); return o && dealId ? `${o}/crm/deal/details/${dealId}/` : null; }

async function listRequests() {
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_procurement ORDER BY created_at DESC');
  return rows.map(r => {
    const stepIndex = stepIndexForStage(r.stage_id);
    return {
      id: r.id, bitrixItemId: r.bitrix_item_id, dealId: r.deal_id, title: r.title,
      stageId: r.stage_id, stepIndex, stepKey: stepIndex >= 0 ? FLOW[stepIndex].key : null,
      createdAt: r.created_at, payload: r.payload || {},
      itemUrl: itemUrl(r.bitrix_item_id), dealUrl: dealUrl(r.deal_id),
    };
  });
}

// Перевод заявки на шаг процесса → пишет соответствующую стадию в 1066.
async function moveStage(localId, stageKey) {
  const step = FLOW.find(s => s.key === stageKey);
  if (!step) throw new Error('Неизвестный шаг процесса');
  const { rows } = await pool.query('SELECT bitrix_item_id FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const itemId = rows[0] && rows[0].bitrix_item_id;
  if (!itemId) throw new Error('Заявка не найдена');
  await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { stageId: step.bitrix } });
  await pool.query('UPDATE ticketsmodule_procurement SET stage_id=$1, updated_at=NOW() WHERE id=$2', [step.bitrix, localId]);
  return { stageId: step.bitrix, stepKey: step.key };
}

// ── Создание заявки: локальная строка + элемент 1066 ────────────────────────
// bitrixUserId — Bitrix-id менеджера склада (ответственный). Источник —
// «Внутренний запрос» (резолвится в мете). Всё, что ввёл менеджер, садится в
// соответствующие поля 1066. Тегируем через xmlId, чтобы дашборд показывал своё.
async function createRequest(payload, bitrixUserId) {
  const meta = await getMeta();
  const title = (payload.title && String(payload.title).trim()) || 'Закуп доп оборудования';

  const fields = { categoryId: CATEGORY, opened: 'Y', title };
  if (bitrixUserId) fields[F.assigned] = bitrixUserId;
  if (meta.internalSourceId) fields[F.source] = meta.internalSourceId;
  if (payload.dealId) fields[F.deal] = Number(payload.dealId);
  if (payload.companyId) fields[F.company] = Number(payload.companyId);
  if (payload.opportunity !== undefined && payload.opportunity !== null && payload.opportunity !== '') fields[F.opportunity] = Number(payload.opportunity) || 0;
  if (payload.currency) fields[F.currency] = payload.currency;
  if (payload.vidZakupki) fields[F.vidZakupki] = payload.vidZakupki;
  fields[F.typeKP] = payload.typeKP || '5816'; // «Закуп» по умолчанию
  if (Array.isArray(payload.proizvoditel) && payload.proizvoditel.length) fields[F.proizvoditel] = payload.proizvoditel;
  if (Array.isArray(payload.pribor) && payload.pribor.length) fields[F.pribor] = payload.pribor;
  if (payload.ustanovka) fields[F.ustanovka] = payload.ustanovka;
  if (payload.oplataPostavshikam) fields[F.oplataPostavshikam] = payload.oplataPostavshikam;
  if (payload.needKztin) fields[F.needKztin] = payload.needKztin;
  if (payload.kztin) fields[F.kztin] = payload.kztin;
  if (payload.po) fields[F.po] = payload.po;
  if (Array.isArray(payload.serial) && payload.serial.length) fields[F.serial] = payload.serial;
  if (payload.cityCountry) fields[F.cityCountry] = payload.cityCountry;
  if (payload.comment) fields[F.comment] = payload.comment;

  // локальная строка сперва — чтобы получить id для тега xmlId
  const ins = await pool.query(
    'INSERT INTO ticketsmodule_procurement (deal_id, title, created_by, payload) VALUES ($1,$2,$3,$4) RETURNING id',
    [payload.dealId || null, title, payload._createdBy || null, payload]
  );
  const localId = ins.rows[0].id;
  fields.xmlId = `${TAG_PREFIX}-${localId}`;

  let item;
  try {
    const { result } = await b24('crm.item.add', { entityTypeId: ENTITY, fields });
    item = result && result.item;
    if (!item) throw new Error('Битрикс не вернул созданный элемент');
  } catch (e) {
    await pool.query('DELETE FROM ticketsmodule_procurement WHERE id=$1', [localId]).catch(() => {});
    throw e;
  }
  await pool.query(
    'UPDATE ticketsmodule_procurement SET bitrix_item_id=$1, stage_id=$2, updated_at=NOW() WHERE id=$3',
    [item.id, item.stageId || null, localId]
  );
  return { localId, bitrixItemId: item.id, stageId: item.stageId || null, itemUrl: itemUrl(item.id) };
}

module.exports = { ENTITY, CATEGORY, TAG_PREFIX, F, DOCS, FLOW, getMeta, searchDeals, listRequests, createRequest, moveStage, itemUrl, dealUrl };

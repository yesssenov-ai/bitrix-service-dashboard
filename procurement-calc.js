// Модуль «Закуп доп оборудования».
// Дашборд менеджера склада создаёт и ведёт элементы смарта «Закупки» (1066,
// категория 13 «Общая»). Здесь: карта полей 1066, динамическая мета для формы
// (стадии + справочники прямо из Битрикса, без хардкода изменчивых ID), поиск
// сделок для привязки, и (в следующей фазе) create/update/move.
const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const { USERS } = require('./constants');

const APP_BASE = process.env.APP_BASE_URL || 'https://bitrix-service-dashboard-production.up.railway.app';
const dashUrl = () => `${APP_BASE}/procurement.html`;
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Человекочитаемая дата-время (Астана) для писем/уведомлений.
const fmtWhen = iso => { try { return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return String(iso || ''); } };
const findUserId = re => { const e = Object.entries(USERS || {}).find(([, name]) => re.test(name)); return e ? Number(e[0]) : null; };
// ВРЕМЕННО (на время настройки модуля): по умолчанию бухгалтер — Куаныш Есенов
// вместо Натальи Зенченко. Чтобы вернуть Зенченко — замени регэксп на /зенченко/i.
const chiefAccountantId = () => findUserId(/есенов|yessenov/i) || findUserId(/зенченко/i);
const warehouseManagerId = () => findUserId(/нурмаганбетов/i);
// Согласующий по умолчанию — Казиев Исабек (подтягивается из Bitrix при hydrateUsers).
const defaultApproverId = () => findUserId(/казиев|исабек/i);

// Авто-создание из завершённого «подбора допов» (смарт «Заявки на сервис» 1058)
const SERVICE_ENTITY = 1058;
const SERVICE_FINAL_STAGE = 'DT1058_11:SUCCESS';          // «Заявка закрыта»
const SERVICE_DOPY_FIELD = 'ufCrm8_1732856507642';        // «Подбор дополнительного оборудования» (file[])
const SERVICE_ZAKUPKI_FIELD = 'ufCrmZakupki';             // обратная связь 1058 → Закупки
const SERVICE_PARENT_DEAL_FIELD = 'ufCrm8_1732856267';    // «Родительский процесс (01 Продажа инструментов)» — сейловая сделка
const VID_POSTAVKA_KLIENTU = '127';                       // «Вид закупки» = Для поставки клиенту
const parseDealRef = v => { if (v == null) return null; const s = String(Array.isArray(v) ? v[0] : v); const m = s.match(/^D_?(\d+)$/i) || s.match(/^(\d+)$/); return m ? Number(m[1]) : null; };

const ENTITY = 1066;         // смарт «Закупки»
const CATEGORY = 13;         // единственная категория «Общая»
const TAG_PREFIX = 'PLS-DOP'; // метка наших заявок в xmlId элемента 1066

// Само-починка схемы: гарантируем наличие колонок, даже если миграция initDB
// (auth.js) не проехала на этом окружении. Выполняется один раз за процесс.
let _schemaReady = null;
function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_procurement (
        id SERIAL PRIMARY KEY, bitrix_item_id INTEGER, deal_id INTEGER,
        title VARCHAR(400), stage_id VARCHAR(60), created_by INTEGER,
        payload JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE ticketsmodule_procurement ADD COLUMN IF NOT EXISTS accountant_bid INTEGER;
      ALTER TABLE ticketsmodule_procurement ADD COLUMN IF NOT EXISTS source_item_id INTEGER;
      -- Файлы документов заявки: источник правды для дашборда и вложений в письма
      -- (множественность на слот + метаданные накладной: склад/дата/комментарий).
      CREATE TABLE IF NOT EXISTS ticketsmodule_procurement_files (
        id SERIAL PRIMARY KEY,
        request_id INTEGER NOT NULL,
        slot VARCHAR(30) NOT NULL,
        filename VARCHAR(400),
        mime VARCHAR(160),
        content_b64 TEXT,
        warehouse VARCHAR(200),
        accept_date DATE,
        comment TEXT,
        uploaded_by INTEGER,
        uploaded_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE ticketsmodule_procurement_files ADD COLUMN IF NOT EXISTS bitrix_file_id INTEGER;
      CREATE INDEX IF NOT EXISTS idx_proc_files_req ON ticketsmodule_procurement_files(request_id);
      -- Отгрузка по сделке: менеджер склада фиксирует «всё отправлено клиенту».
      CREATE TABLE IF NOT EXISTS ticketsmodule_procurement_deal_ship (
        deal_id INTEGER PRIMARY KEY,
        closed_at TIMESTAMPTZ,
        closed_by INTEGER);
      -- ТТН: item_id NULL — основная отгрузка (уровень сделки); item_id задан —
      -- доотправка по конкретной закупке (1066), созданной после фиксации.
      CREATE TABLE IF NOT EXISTS ticketsmodule_procurement_ship_files (
        id SERIAL PRIMARY KEY,
        deal_id INTEGER NOT NULL,
        item_id INTEGER,
        filename VARCHAR(400),
        mime VARCHAR(160),
        content_b64 TEXT,
        uploaded_by INTEGER,
        uploaded_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_proc_ship_files_deal ON ticketsmodule_procurement_ship_files(deal_id);
      -- Аудит удалённых закупок: кто, когда, что удалил (снимок на момент удаления).
      CREATE TABLE IF NOT EXISTS ticketsmodule_procurement_audit (
        id SERIAL PRIMARY KEY,
        action VARCHAR(20) DEFAULT 'delete',
        request_id INTEGER,
        bitrix_item_id INTEGER,
        deal_id INTEGER,
        title VARCHAR(400),
        stage_id VARCHAR(60),
        opportunity DOUBLE PRECISION,
        currency VARCHAR(10),
        files JSONB,
        snapshot JSONB,
        actor_bid INTEGER,
        actor_name VARCHAR(200),
        comment TEXT,
        at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE ticketsmodule_procurement_audit ADD COLUMN IF NOT EXISTS comment TEXT;
      CREATE INDEX IF NOT EXISTS idx_proc_audit_at ON ticketsmodule_procurement_audit(at DESC);
    `);
  })().catch(e => { _schemaReady = null; throw e; });
  return _schemaReady;
}

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

// ── Документы: 4 файловых поля 1066 ─────────────────────────────────────────
// Коды полей резолвятся ДИНАМИЧЕСКИ по названию поля (resolveDocFields ниже) —
// так дашборд сам «привязывается» к полям, которые менеджер создал в Битриксе
// («Счет на оплату», «Подтверждение оплаты», «Накладная», «Гарантийный
// сертификат»). Значения ниже — только резерв на случай, если поле не нашлось.
// Резервные коды (точные, подтверждены discovery 1066). Основной способ —
// динамический резолв по названию (resolveDocFields), это лишь fallback.
const DOC_INVOICE = 'ufCrm10_1786717634809';   // «Счет на оплату»
const DOC_PAY = 'ufCrm10_1786717656594';       // «Подтверждение оплаты» (новое)
const DOC_CONTRACT = 'ufCrm10_1786717668866';  // «Накладная»
const DOC_WARRANTY = process.env.PROC_WARRANTY_FIELD || 'ufCrm10_1786717682346'; // «Гарантийный сертификат»
const APPROVE_YES = '1827';                    // «Согласовано» (поле Согласование предоплаты)
// Слоты загрузки: ключ + подпись (код подтягивается динамически по названию).
const UPLOAD_SLOT_DEFS = [
  { key: 'invoice',  label: 'Счет на оплату',           re: /сч[её]т.*оплат/i,       fallback: DOC_INVOICE },
  { key: 'pay',      label: 'Подтверждение оплаты',      re: /подтвержд.*оплат/i,     fallback: DOC_PAY },
  { key: 'poa',      label: 'Доверенность',              re: /доверенн/i,             fallback: process.env.PROC_POA_FIELD || 'ufCrm10_1787059241414' },
  { key: 'contract', label: 'Накладная',                 re: /накладн/i,              fallback: DOC_CONTRACT },
  { key: 'warranty', label: 'Гарантийный сертификат',    re: /гаранти.*сертиф/i,      fallback: DOC_WARRANTY },
];
// Резолв кодов файловых полей по названию (кэш 30 мин). При нескольких полях с
// одинаковым названием берём НОВЕЙШЕЕ (наибольший числовой суффикс кода) — это и
// есть только что созданное менеджером поле.
let _docFields = null, _docAt = 0;
async function resolveDocFields(force) {
  if (_docFields && !force && Date.now() - _docAt < 30 * 60 * 1000) return _docFields;
  const map = {}; UPLOAD_SLOT_DEFS.forEach(s => { map[s.key] = s.fallback; });
  try {
    const { result } = await b24('crm.item.fields', { entityTypeId: ENTITY });
    const fields = (result && result.fields) || {};
    const fileFields = Object.entries(fields).filter(([, f]) => String(f.type).toLowerCase() === 'file');
    const codeNum = c => { const m = String(c).match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; };
    for (const s of UPLOAD_SLOT_DEFS) {
      const hits = fileFields.filter(([, f]) => s.re.test(String(f.title || '').trim()));
      if (hits.length) { hits.sort((a, b) => codeNum(b[0]) - codeNum(a[0])); map[s.key] = hits[0][0]; }
    }
  } catch (e) { console.error('resolveDocFields:', e.message); }
  _docFields = map; _docAt = Date.now();
  return _docFields;
}
// Условия для перехода НА шаг (по ключам слотов; коды резолвятся при проверке).
const REQUIREMENTS = {
  contract: { kind: 'file', slot: 'invoice', label: 'счёт (Invoice)' },
  payment:  { kind: 'approval', label: 'согласование закупки' },
  waiting:  { kind: 'file', slot: 'pay', label: 'подтверждение оплаты' },
  received: { kind: 'files', slots: ['contract', 'warranty'], label: 'накладная и гарантийный сертификат' },
};
const fileNonEmpty = v => !!(v && (Array.isArray(v) ? v.length : true));

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
  const [stages, sources, currencies, vidZakupki, docFields] = await Promise.all([
    getStages(), getSources(), getCurrencies(), iblockOptions(fields[F.vidZakupki]), resolveDocFields(force),
  ]);
  const uploadSlots = UPLOAD_SLOT_DEFS.map(s => ({ key: s.key, code: docFields[s.key], label: s.label }));
  const employees = Object.entries(USERS || {}).map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  const defaultAssignee = (employees.find(e => /нурмаганбетов/i.test(e.name)) || {}).id || null;
  const meta = {
    entity: ENTITY, category: CATEGORY,
    stages,
    flow: FLOW.map(s => ({ key: s.key, label: s.label, bitrix: s.bitrix })),
    sources,
    employees,
    defaultAssignee,
    approve: { yes: APPROVE_YES, no: '1828', options: [{ id: '1827', label: 'Согласовано' }, { id: '1828', label: 'Не согласовано' }] },
    chiefAccountant: chiefAccountantId(),
    defaultApprover: defaultApproverId(),
    uploadSlots,
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

// ── Поиск сделок для привязки: по любому совпадению названия во ВСЕХ воронках,
// плюс точное совпадение по номеру (ID), если ввели число ────────────────────
const DEAL_SEL = ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'COMPANY_ID', 'OPPORTUNITY', 'CURRENCY_ID'];
const mapDeal = d => ({
  id: Number(d.ID), title: d.TITLE || ('Сделка #' + d.ID), stageId: d.STAGE_ID,
  categoryId: Number(d.CATEGORY_ID), companyId: d.COMPANY_ID ? Number(d.COMPANY_ID) : null,
  opportunity: parseFloat(d.OPPORTUNITY) || 0, currency: d.CURRENCY_ID || 'KZT',
});
async function searchDeals(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const out = [], seen = new Set();
  const add = arr => (arr || []).forEach(d => { const id = Number(d.ID); if (!seen.has(id)) { seen.add(id); out.push(mapDeal(d)); } });
  // 1) подстрока в названии (без фильтра по категории → все воронки)
  try {
    const { result } = await b24('crm.deal.list', { filter: { '%TITLE': q }, select: DEAL_SEL, order: { ID: 'DESC' }, start: 0 });
    add(result);
  } catch (e) { console.error('searchDeals title:', e.message); }
  // 2) точное совпадение по ID (если ввели число) — вдруг искали по номеру сделки
  if (/^\d+$/.test(q)) {
    try { const { result } = await b24('crm.deal.list', { filter: { ID: q }, select: DEAL_SEL }); add(result); } catch (e) { /* ignore */ }
  }
  return out.slice(0, 25);
}

// ── Компания + БИН ──────────────────────────────────────────────────────────
// Поиск компаний в CRM (по названию), поиск по БИН в реквизитах Bitrix и
// резолв БИН через ГБД ЮЛ (внешний реестр РК). Провайдер настраивается через
// env BIN_LOOKUP_URL с плейсхолдером {bin}; по умолчанию — открытый apiba.
// Провайдеры резолва БИН (ГБД ЮЛ). Пробуем по очереди; env BIN_LOOKUP_URL, если
// задан, идёт первым. Плейсхолдер {bin}. Возвращаем и диагностику — чтобы было
// видно, ПОЧЕМУ не нашлось (таймаут / HTTP-код / блок сети на Railway).
const BIN_PROVIDERS = [
  process.env.BIN_LOOKUP_URL,
  'https://apiba.prgapp.kz/CompanyFullInfo?id={bin}&lang=ru',
].filter(Boolean);
let _fetch = (typeof fetch === 'function') ? fetch : null;
if (!_fetch) { try { _fetch = require('node-fetch'); } catch (e) { _fetch = null; } }
// Возвращает { status, json, error } — не бросает.
async function httpJson(url, ms = 8000) {
  if (!_fetch) return { error: 'fetch недоступен' };
  let ctrl, t;
  try { ctrl = new AbortController(); t = setTimeout(() => ctrl.abort(), ms); } catch (e) { ctrl = null; }
  try {
    const opts = { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (PLS-CUP)', referer: 'https://ba.prg.kz/' } };
    if (ctrl) opts.signal = ctrl.signal;
    const r = await _fetch(url, opts);
    if (!r.ok) return { status: r.status, error: 'HTTP ' + r.status };
    let json = null; try { json = await r.json(); } catch (e) { return { status: r.status, error: 'не JSON' }; }
    return { status: r.status, json };
  } catch (e) { return { error: (e.name === 'AbortError' ? 'таймаут' : e.message) }; }
  finally { if (t) clearTimeout(t); }
}
// Достаём название из значения: строка ИЛИ объект-обёртка { value: '...' }
// (apiba оборачивает поля как {value,color,...} → имя лежит в basicInfo.titleRu.value).
function nameFromVal(v) {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && typeof v.value === 'string') return v.value.trim() || null;
  return null;
}
function pickCompanyName(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 5) return null;
  const keys = ['nameRu', 'nameKz', 'name', 'shortNameRu', 'shortName', 'fullNameRu', 'fullName', 'titleRu', 'titleKz', 'title', 'companyName', 'nameOfCompany'];
  for (const k of keys) { const n = nameFromVal(o[k]); if (n) return n; }
  for (const nest of ['company', 'result', 'results', 'data', 'basicInfo', 'info', 'obj', 'item', 'items', 'content']) {
    const v = o[nest]; const arr = Array.isArray(v) ? v[0] : v;
    const n = pickCompanyName(arr, depth + 1); if (n) return n;
  }
  return null;
}
// Пробует провайдеров по очереди; возвращает { name, source, debug[] }.
async function lookupBinExternal(bin) {
  const debug = [];
  for (const tmpl of BIN_PROVIDERS) {
    const host = (() => { try { return new URL(tmpl).host; } catch (e) { return tmpl.slice(0, 24); } })();
    const res = await httpJson(tmpl.replace('{bin}', encodeURIComponent(bin)));
    if (res.error) { debug.push(`${host}: ${res.error}`); continue; }
    const name = pickCompanyName(res.json);
    if (name) return { name, source: host, debug };
    debug.push(`${host}: без имени`);
  }
  return { name: null, source: null, debug };
}
// Найти компанию Bitrix по БИН через реквизиты (RQ_BIN). Может 403, если у
// вебхука нет доступа к crm.requisite — тогда просто вернём null.
async function bitrixCompanyByBin(bin) {
  try {
    const { result } = await b24('crm.requisite.list', { filter: { RQ_BIN: bin }, select: ['ID', 'ENTITY_ID', 'ENTITY_TYPE_ID'] });
    const req = (result || []).find(r => String(r.ENTITY_TYPE_ID) === '4'); // 4 = компания
    if (!req) return null;
    const id = Number(req.ENTITY_ID);
    try { const c = await b24('crm.company.get', { id }); return { id, title: (c.result && (c.result.TITLE || c.result.title)) || ('Компания #' + id) }; }
    catch (e) { return { id, title: 'Компания #' + id }; }
  } catch (e) { return null; }
}
async function searchCompanies(q) {
  q = String(q || '').trim(); if (q.length < 2) return [];
  const out = [], seen = new Set();
  const add = (id, title, bin) => { id = Number(id); if (!seen.has(id)) { seen.add(id); out.push({ id, title: title || ('Компания #' + id), bin: bin || null }); } };
  try { const { result } = await b24('crm.company.list', { filter: { '%TITLE': q }, select: ['ID', 'TITLE'], order: { ID: 'DESC' } }); (result || []).forEach(c => add(c.ID, c.TITLE)); }
  catch (e) { console.error('searchCompanies:', e.message); }
  if (/^\d{12}$/.test(q)) { const bc = await bitrixCompanyByBin(q); if (bc) add(bc.id, bc.title, q); }
  return out.slice(0, 20);
}
async function resolveBin(bin) {
  bin = String(bin || '').replace(/\D/g, '');
  if (!/^\d{12}$/.test(bin)) return { bin, found: false, error: 'БИН должен содержать 12 цифр' };
  const [bc, ext] = await Promise.all([bitrixCompanyByBin(bin), lookupBinExternal(bin)]);
  const name = (ext && ext.name) || (bc && bc.title) || null;
  const debug = (ext && ext.debug || []).join(' · ');
  if (!name) console.error('resolveBin', bin, '→ не найдено. Провайдеры:', debug);
  return { bin, found: !!name, name, bitrixCompanyId: bc ? bc.id : null, source: name ? (ext && ext.name ? (ext.source || 'gbd') : 'bitrix') : null, debug };
}

// ── Список наших заявок (из локальной таблицы) + актуальная стадия ───────────
function bitrixOrigin() { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return null; } }
function itemUrl(itemId) { const o = bitrixOrigin(); return o && itemId ? `${o}/crm/type/${ENTITY}/details/${itemId}/` : null; }
function dealUrl(dealId) { const o = bitrixOrigin(); return o && dealId ? `${o}/crm/deal/details/${dealId}/` : null; }

async function listRequests() {
  await ensureSchema();
  pruneOldFileBytes(); // фоновая чистка временных байтов (throttled)
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_procurement ORDER BY created_at DESC');
  return rows.map(r => {
    const stepIndex = stepIndexForStage(r.stage_id);
    return {
      id: r.id, bitrixItemId: r.bitrix_item_id, dealId: r.deal_id, title: r.title,
      stageId: r.stage_id, stepIndex, stepKey: stepIndex >= 0 ? FLOW[stepIndex].key : null,
      accountantBid: r.accountant_bid || null, sourceItemId: r.source_item_id || null,
      createdAt: r.created_at, payload: r.payload || {},
      itemUrl: itemUrl(r.bitrix_item_id), dealUrl: dealUrl(r.deal_id),
    };
  });
}

async function itemIdOf(localId) {
  const { rows } = await pool.query('SELECT bitrix_item_id FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const itemId = rows[0] && rows[0].bitrix_item_id;
  if (!itemId) throw new Error('Заявка не найдена');
  return itemId;
}

// Контекст заявки для уведомлений (id элемента, инициатор, согласующий, бухгалтер).
// creatorBid: Bitrix-id инициатора — из аккаунта дашборда, а если он не привязан
// к Bitrix, берём initiatorBid из payload (сохраняется при создании).
async function getRequestContext(localId) {
  const { rows } = await pool.query(
    `SELECT p.bitrix_item_id, p.deal_id, p.title, p.accountant_bid, p.payload, u.bitrix_user_id AS creator_bid
       FROM ticketsmodule_procurement p LEFT JOIN ticketsmodule_users u ON u.id = p.created_by
      WHERE p.id=$1`, [localId]);
  const r = rows[0];
  if (!r || !r.bitrix_item_id) throw new Error('Заявка не найдена');
  const pl = r.payload || {};
  return {
    localId, itemId: r.bitrix_item_id, dealId: r.deal_id, title: r.title,
    creatorBid: r.creator_bid || pl.initiatorBid || null,
    approverBid: pl.apApprover || null,
    accountantBid: r.accountant_bid || null,
    itemUrl: itemUrl(r.bitrix_item_id), dealUrl: dealUrl(r.deal_id),
  };
}

// Назначить/сменить бухгалтера, ответственного за оплату (напр. если основной в
// отпуске), и уведомить нового.
async function setAccountant(localId, accountantBid) {
  if (!accountantBid) throw new Error('Не выбран бухгалтер');
  await pool.query('UPDATE ticketsmodule_procurement SET accountant_bid=$1, updated_at=NOW() WHERE id=$2', [accountantBid, localId]);
  try {
    const ctx = await getRequestContext(localId);
    const { notifyPerson, emailHtml } = require('./procurement-notify');
    const t = ctx.title || ('#' + ctx.itemId);
    const tg = `👤 <b>Вы назначены на оплату закупки</b>\n📋 ${esc(t)}\nСчёт на оплату во вложении (если приложен).\n<a href="${dashUrl()}">Открыть в дашборде</a>${ctx.itemUrl ? ` · <a href="${ctx.itemUrl}">в Битриксе</a>` : ''}`;
    const html = emailHtml({ title: 'Вы назначены на оплату закупки', color: '#0f766e', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')]], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
    const attachments = await slotAttachments(localId, 'invoice');
    await notifyPerson(accountantBid, { reason: 'Назначен бухгалтер', tgText: tg, subject: 'Вы назначены на оплату закупки #' + ctx.itemId, html, itemId: ctx.itemId, attachments });
  } catch (e) { /* уведомление best-effort */ }
  return { ok: true };
}

// Отправить закупку на согласование одному ИЛИ нескольким руководителям (+ уведомить их).
// approvers — массив Bitrix-id (или один id). Согласование считается полученным,
// когда КАЖДЫЙ из выбранных согласовал; отклонение хотя бы одним — отклоняет всю закупку.
async function requestApproval(localId, approvers) {
  let ids = Array.isArray(approvers) ? approvers : [approvers];
  ids = [...new Set(ids.filter(Boolean).map(String))];
  if (!ids.length) throw new Error('Не выбран согласующий');
  const ctx = await getRequestContext(localId);
  // В Bitrix-поле «Утверждающий» пишем первого (поле одиночное) — для совместимости.
  await b24('crm.item.update', { entityTypeId: ENTITY, id: ctx.itemId, fields: { [F.preApprover]: ids[0] } });
  // Локальный статус «На согласовании» — сбрасываем прошлые решения.
  try {
    const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
    const pl = (rows[0] && rows[0].payload) || {};
    pl.apRequested = true; pl.apDecided = false;
    pl.apApprovers = ids;             // список согласующих
    pl.apApprover = ids[0];           // совместимость со старым кодом/полем
    pl.apDecisions = {};              // решения: bid -> {status, comment, at, name}
    pl.apRequestedAt = new Date().toISOString();
    delete pl.apDecidedAt;
    await pool.query('UPDATE ticketsmodule_procurement SET payload=$1, updated_at=NOW() WHERE id=$2', [pl, localId]);
  } catch (e) { /* флаг не критичен */ }
  const { notifyPerson, emailHtml } = require('./procurement-notify');
  const t = ctx.title || ('#' + ctx.itemId);
  const attachments = await slotAttachments(localId, 'invoice');
  const others = ids.length > 1 ? ids.map(id => USERS[id] || ('#' + id)).join(', ') : null;
  for (const approverId of ids) {
    const tg = `🟠 <b>Закупка на согласование</b>\n📋 ${esc(t)}${ctx.dealId ? `\n🔗 Сделка #${ctx.dealId}` : ''}\n\nТребуется ваше согласование (счёт на оплату во вложении).${others ? `\n👥 Согласующие: ${esc(others)}` : ''}\n<a href="${dashUrl()}">Открыть в дашборде</a>${ctx.itemUrl ? ` · <a href="${ctx.itemUrl}">в Битриксе</a>` : ''}`;
    const html = emailHtml({ title: 'Закупка на согласование', color: '#d97706', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(ctx.dealId ? [['Сделка', '#' + ctx.dealId]] : []), ...(others ? [['Согласующие', others]] : []), ['Кому', USERS[approverId] || ('#' + approverId)]], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
    await notifyPerson(approverId, { reason: 'Запрос согласования', tgText: tg, subject: 'Закупка на согласование #' + ctx.itemId, html, itemId: ctx.itemId, attachments });
  }
  return { ok: true, approvers: ids };
}

// Редактирование заявки: базовые поля (название, источник, ответственный, вид закупки).
async function updateRequest(localId, payload) {
  const itemId = await itemIdOf(localId);
  const fields = {};
  if (payload.title != null) fields[F.title] = payload.title;
  if (payload.source) fields[F.source] = payload.source;
  if (payload.assigned) fields[F.assigned] = payload.assigned;
  if (payload.vidZakupki) fields[F.vidZakupki] = payload.vidZakupki;
  if (payload.opportunity !== undefined && payload.opportunity !== null && payload.opportunity !== '') fields[F.opportunity] = Number(payload.opportunity) || 0;
  if (payload.currency) fields[F.currency] = payload.currency;
  if (Object.keys(fields).length) await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields });
  // сливаем в снимок payload, чтобы форма редактирования показывала актуальное
  const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const merged = Object.assign({}, rows[0] && rows[0].payload || {}, payload);
  await pool.query('UPDATE ticketsmodule_procurement SET title=$1, payload=$2, updated_at=NOW() WHERE id=$3', [payload.title || null, merged, localId]);
  return { ok: true };
}

// Удаление заявки: элемент 1066 + локальная строка.
async function deleteRequest(localId, byBid, reason) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const r = rows[0];
  const itemId = r && r.bitrix_item_id;
  // Снимок приложенных файлов (метаданные) для аудита.
  let filesSnap = [];
  try {
    const fr = await pool.query('SELECT slot, filename, warehouse, accept_date, comment, uploaded_at FROM ticketsmodule_procurement_files WHERE request_id=$1 ORDER BY id', [localId]);
    filesSnap = fr.rows.map(f => ({ slot: f.slot, name: f.filename, warehouse: f.warehouse, acceptDate: f.accept_date, comment: f.comment, uploadedAt: f.uploaded_at }));
  } catch (e) { /* некритично */ }
  // Пишем аудит ДО удаления.
  try {
    const pl = (r && r.payload) || {};
    await pool.query(
      `INSERT INTO ticketsmodule_procurement_audit (action, request_id, bitrix_item_id, deal_id, title, stage_id, opportunity, currency, files, snapshot, actor_bid, actor_name, comment)
       VALUES ('delete',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [localId, itemId || null, (r && r.deal_id) || null, (r && r.title) || null, (r && r.stage_id) || null,
       pl.opportunity != null ? Number(pl.opportunity) : null, pl.currency || null,
       JSON.stringify(filesSnap), JSON.stringify(pl),
       byBid || null, byBid ? (USERS[byBid] || ('#' + byBid)) : null,
       String(reason || '').trim() || null]);
  } catch (e) { console.error('procurement audit write:', e.message); }
  if (itemId) { try { await b24('crm.item.delete', { entityTypeId: ENTITY, id: itemId }); } catch (e) { console.error('procurement delete item:', e.message); } }
  await pool.query('DELETE FROM ticketsmodule_procurement_files WHERE request_id=$1', [localId]).catch(() => {});
  await pool.query('DELETE FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  return { ok: true };
}

// Журнал удалённых закупок (для админа).
async function listDeletions(limit) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT request_id, bitrix_item_id, deal_id, title, stage_id, opportunity, currency, files, actor_name, comment, at
       FROM ticketsmodule_procurement_audit WHERE action='delete' ORDER BY at DESC LIMIT $1`, [Math.min(Number(limit) || 200, 1000)]);
  const sName = {}; try { (await getStages()).forEach(s => { sName[s.id] = s.name; }); } catch (e) {}
  return rows.map(r => ({
    requestId: r.request_id, bitrixItemId: r.bitrix_item_id, dealId: r.deal_id,
    title: r.title, stageId: r.stage_id, stageName: sName[r.stage_id] || r.stage_id,
    opportunity: r.opportunity, currency: r.currency,
    files: r.files || [], filesCount: Array.isArray(r.files) ? r.files.length : 0,
    actorName: r.actor_name, reason: r.comment || '', at: r.at,
    dealUrl: dealUrl(r.deal_id),
  }));
}

// Карта стадий 1066 (id → имя), кэш 30 мин — для представления «по сделке».
let _stageMap = null, _stageMapAt = 0;
async function stageNameMap() {
  if (_stageMap && Date.now() - _stageMapAt < 30 * 60 * 1000) return _stageMap;
  const st = await getStages(); const m = {}; st.forEach(s => { m[s.id] = s.name; });
  _stageMap = m; _stageMapAt = Date.now();
  return m;
}
const SUCCESS_STAGES = /:SUCCESS$/i;
const FAIL_STAGES = /:(FAIL|6)$/i;

// Все закупки (1066) по одной сделке (parentId2) + их статусы. Показывает и наши
// (доп-оборудование из дашборда), и импортные — полная картина по сделке.
async function listByDeal(dealId) {
  dealId = Number(dealId);
  if (!dealId) return { dealId: null, items: [] };
  const [smap, lr, shipment] = await Promise.all([
    stageNameMap(),
    pool.query('SELECT bitrix_item_id, id, title FROM ticketsmodule_procurement WHERE deal_id=$1', [dealId]),
    getDealShipment(dealId),
  ]);
  const localByItem = {}, localTitleByItem = {};
  lr.rows.forEach(r => { if (r.bitrix_item_id) { localByItem[r.bitrix_item_id] = r.id; localTitleByItem[r.bitrix_item_id] = r.title; } });
  const isDashTitle = t => !String(t || '').trim() || /^[\s\-–—]+$/.test(String(t));
  let items = [];
  try {
    let start = 0;
    while (true) {
      const { result } = await b24('crm.item.list', {
        entityTypeId: ENTITY, filter: { parentId2: dealId },
        select: ['id', 'title', 'stageId', 'opportunity', 'currencyId', 'xmlId', 'assignedById', 'createdTime'], start,
      });
      const batch = (result && result.items) || [];
      items = items.concat(batch);
      const total = result && result.total; start += batch.length;
      if (!batch.length || (total != null && start >= total) || batch.length < 50) break;
      if (start > 2000) break;
    }
  } catch (e) { console.error('listByDeal error:', e.message); }
  const closedMs = shipment.closed && shipment.closedAt ? new Date(shipment.closedAt).getTime() : null;
  return {
    dealId, dealUrl: dealUrl(dealId),
    shipment,
    items: items.map(it => {
      const createdTime = it.createdTime || null;
      const createdMs = createdTime ? new Date(createdTime).getTime() : null;
      // «Доотправка» — закупка создана ПОЗЖЕ фиксации «всё отправлено».
      const isReship = closedMs != null && createdMs != null && createdMs > closedMs;
      // Если в Битриксе заголовок «- - -»/пустой — показываем наше название из ЦУП.
      let title = it.title || '';
      if (isDashTitle(title) && localTitleByItem[it.id] && !isDashTitle(localTitleByItem[it.id])) title = localTitleByItem[it.id];
      if (isDashTitle(title)) title = 'Закупка #' + it.id;
      return {
        id: it.id, title,
        stageId: it.stageId, stageName: smap[it.stageId] || it.stageId,
        sem: SUCCESS_STAGES.test(it.stageId) ? 'ok' : (FAIL_STAGES.test(it.stageId) ? 'fail' : 'work'),
        sum: parseFloat(it.opportunity) || 0, currency: it.currencyId || 'KZT',
        assignedId: it.assignedById || null, assignedName: it.assignedById ? (USERS[it.assignedById] || ('#' + it.assignedById)) : null,
        url: itemUrl(it.id),
        createdTime,
        isReship,
        ttn: shipment.reshipByItem[it.id] || [],
        isOurs: /^PLS-DOP/i.test(String(it.xmlId || '')) || !!localByItem[it.id],
        localId: localByItem[it.id] || null,
      };
    }),
  };
}

// Перевод заявки на шаг процесса → пишет стадию в 1066. С проверкой условий:
// на нужные шаги нельзя перейти, пока не приложены документы / не согласовано.
async function moveStage(localId, stageKey, opts = {}) {
  const step = FLOW.find(s => s.key === stageKey);
  if (!step) throw new Error('Неизвестный шаг процесса');
  const targetIdx = FLOW.findIndex(s => s.key === stageKey);
  const itemId = await itemIdOf(localId);
  const { rows: cur } = await pool.query('SELECT stage_id, payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const curStageId = cur[0] && cur[0].stage_id;
  const curIdx = stepIndexForStage(curStageId);
  const isBackward = curIdx >= 0 && targetIdx >= 0 && targetIdx < curIdx;

  // Откат назад — только с причиной (обязательно). Вперёд — как раньше.
  if (isBackward) {
    const reason = String(opts.reason || '').trim();
    if (!reason) { const e = userFacing('Для отката назад укажите причину.'); e.needReason = true; throw e; }
  }

  // Проверка условий — только при движении ВПЕРЁД (откат назад не блокируем).
  const reqmt = isBackward ? null : REQUIREMENTS[stageKey];
  if (reqmt) {
    if (reqmt.kind === 'file' || reqmt.kind === 'files') {
      const files = await filesFor(localId);
      const has = sl => (files[sl] || []).length > 0;
      if (reqmt.kind === 'file' && !has(reqmt.slot)) throw userFacing(`Нельзя перейти на «${step.label}»: не приложен ${reqmt.label}.`);
      if (reqmt.kind === 'files' && !reqmt.slots.every(has)) throw userFacing(`Нельзя перейти на «${step.label}»: нужны ${reqmt.label}.`);
    } else if (reqmt.kind === 'approval') {
      const { result } = await b24('crm.item.get', { entityTypeId: ENTITY, id: itemId });
      const item = (result && result.item) || {};
      const ok = String(item[F.preApprove]) === APPROVE_YES && !!item[F.preApprover];
      if (!ok) throw userFacing(`Нельзя перейти на «${step.label}»: нужен ${reqmt.label}.`);
    }
  }

  await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { stageId: step.bitrix } });

  // Пишем стадию + (для отката) запись в историю откатов с причиной/датой/кем.
  if (isBackward) {
    const pl = (cur[0] && cur[0].payload) || {};
    pl.rollbacks = Array.isArray(pl.rollbacks) ? pl.rollbacks : [];
    pl.rollbacks.unshift({
      fromKey: curIdx >= 0 ? FLOW[curIdx].key : null,
      fromLabel: curIdx >= 0 ? FLOW[curIdx].label : (curStageId || '—'),
      toKey: step.key, toLabel: step.label,
      reason: String(opts.reason || '').trim(),
      at: new Date().toISOString(),
      byBid: opts.byBid || null,
      byName: opts.byBid ? (USERS[opts.byBid] || ('#' + opts.byBid)) : null,
    });
    // Откат с «Товар принят» назад — снимаем отметку «полностью принят».
    if (curIdx === FLOW.length - 1) { pl.fullyReceived = false; pl.fullyReceivedAt = null; pl.fullyReceivedBy = null; }
    await pool.query('UPDATE ticketsmodule_procurement SET stage_id=$1, payload=$2, updated_at=NOW() WHERE id=$3', [step.bitrix, pl, localId]);
    // Уведомляем об откате (с причиной) инициатора, согласующего, бухгалтера.
    notifyRollback(localId, (curIdx >= 0 ? FLOW[curIdx].label : (curStageId || '—')), step.label, String(opts.reason || '').trim(), opts.byBid ? (USERS[opts.byBid] || ('#' + opts.byBid)) : null).catch(() => {});
  } else {
    await pool.query('UPDATE ticketsmodule_procurement SET stage_id=$1, updated_at=NOW() WHERE id=$2', [step.bitrix, localId]);
  }

  // Переход на «Ожидание товара» = оплата завершена → письмо с платёжкой и
  // доверенностью в одном сообщении.
  if (stageKey === 'waiting' && !isBackward) { notifyPaymentDone(localId, opts.byBid).catch(() => {}); }
  // Уведомление «Товар принят» шлём НЕ при входе на стадию (может быть частичная
  // приёмка), а при отметке «Полностью принят» — см. setFullyReceived.
  return { stageId: step.bitrix, stepKey: step.key };
}

// История стадий элемента 1066: когда он входил в каждую стадию (для таймлайна).
// Порталы капризны к параметрам — пробуем варианты и фильтруем по OWNER_ID.
async function stageHistory(itemId) {
  const variants = [
    { entityTypeId: ENTITY, filter: { OWNER_ID: itemId }, order: { ID: 'ASC' } },
    { entityTypeId: ENTITY, filter: { ownerId: itemId } },
    { entityTypeId: ENTITY },
  ];
  for (const v of variants) {
    try {
      const { result } = await b24('crm.stagehistory.list', { ...v, start: 0 });
      let items = Array.isArray(result) ? result : ((result && result.items) || []);
      items = items.filter(h => String(h.OWNER_ID || h.ownerId) === String(itemId));
      if (items.length) return items;
    } catch (e) { /* пробуем следующий вариант */ }
  }
  return [];
}
// Карта «стадия → дата первого входа» (ISO), из истории стадий.
async function stageDatesFor(itemId) {
  const out = {};
  try {
    const hist = await stageHistory(itemId);
    hist.forEach(h => {
      const sid = h.STAGE_ID || h.stageId; const t = h.CREATED_TIME || h.createdTime;
      if (sid && t && !out[sid]) out[sid] = t;
    });
  } catch (e) { /* best-effort */ }
  return out;
}

// Детали заявки: документы (приложены?) и статус согласования — из 1066.
async function getItemDetail(localId) {
  const itemId = await itemIdOf(localId);
  const { result } = await b24('crm.item.get', { entityTypeId: ENTITY, id: itemId });
  const item = (result && result.item) || {};
  const { rows: lr } = await pool.query('SELECT payload, source_item_id FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const pl = (lr[0] && lr[0].payload) || {};
  const docNames = pl.docNames || {};
  const sid = lr[0] && lr[0].source_item_id;
  const fileInfo = (code, key) => {
    const v = item[code]; if (!v) return null; const f = Array.isArray(v) ? v[0] : v; if (!f) return null;
    return { name: docNames[key] || f.name || f.NAME || f.originalName || 'файл', url: f.urlMachine || f.url || f.downloadUrl || null };
  };
  // Файлы допов из подбора (1058) — ссылочно, без копирования
  let dopy = null;
  if (sid) {
    try {
      const { result: sr } = await b24('crm.item.get', { entityTypeId: SERVICE_ENTITY, id: sid });
      const sitem = (sr && sr.item) || {};
      const raw = sitem[SERVICE_DOPY_FIELD];
      const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const files = arr.map(f => ({ name: f.name || f.NAME || 'файл', url: f.urlMachine || f.url || f.downloadUrl || null }));
      const o = bitrixOrigin();
      dopy = { files, serviceUrl: o ? `${o}/crm/type/${SERVICE_ENTITY}/details/${sid}/` : null };
    } catch (e) { /* best-effort */ }
  }
  const [stageDates, docFields, files] = await Promise.all([stageDatesFor(itemId), resolveDocFields(), filesFor(localId)]);
  return {
    stageId: item.stageId,
    stageDates,
    // Множественные файлы по слотам (источник правды — локальная таблица).
    files,
    fullyReceived: !!pl.fullyReceived,
    fullyReceivedAt: pl.fullyReceivedAt || null,
    fullyReceivedBy: pl.fullyReceivedBy || null,
    rollbacks: Array.isArray(pl.rollbacks) ? pl.rollbacks : [],
    docs: { invoice: fileInfo(docFields.invoice, 'invoice'), pay: fileInfo(docFields.pay, 'pay'), contract: fileInfo(docFields.contract, 'contract'), warranty: fileInfo(docFields.warranty, 'warranty') },
    dopy,
    approval: (() => {
      const apprIds = Array.isArray(pl.apApprovers) && pl.apApprovers.length
        ? pl.apApprovers.map(String)
        : ((item[F.preApprover] || pl.apApprover) ? [String(item[F.preApprover] || pl.apApprover)] : []);
      const dec = pl.apDecisions || {};
      const approvers = apprIds.map(bid => {
        const d = dec[bid] || null;
        return {
          bid, name: USERS[bid] || ('#' + bid),
          status: d ? String(d.status) : null,
          approved: d ? String(d.status) === APPROVE_YES : false,
          decided: !!d,
          comment: d ? (d.comment || '') : '',
          at: d ? (d.at || null) : null,
        };
      });
      return {
        status: item[F.preApprove] != null ? String(item[F.preApprove]) : null,
        approver: item[F.preApprover] || pl.apApprover || null,
        approvers,                       // список согласующих + их решения
        comment: item[F.preApproveComment] || '',
        approved: String(item[F.preApprove]) === APPROVE_YES,
        requested: !!pl.apRequested,
        decided: !!pl.apDecided,
        decidedAt: pl.apDecidedAt || null,
      };
    })(),
  };
}

// Загрузка документа в файловое поле 1066 (перезаписывает поле новым файлом).
// Если загрузили «Подтверждение оплаты» — уведомляем создателя заявки.
async function uploadDoc(localId, fieldCode, filename, base64) {
  const docFields = await resolveDocFields();
  const codeToKey = {}; Object.entries(docFields).forEach(([k, code]) => { codeToKey[code] = k; });
  if (!codeToKey[fieldCode]) throw new Error('Недопустимое поле для загрузки');
  const itemId = await itemIdOf(localId);
  // Формат файла для crm.item: { fileData: [имя, base64] } (без обёртки в массив —
  // иначе Битрикс принимает запрос, но файл не прикрепляет).
  await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: { fileData: [filename, base64] } } });
  // Сохраняем имя файла локально — crm.item.get не всегда возвращает имя.
  try {
    const key = codeToKey[fieldCode];
    if (key) {
      const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
      const pl = (rows[0] && rows[0].payload) || {};
      pl.docNames = Object.assign({}, pl.docNames, { [key]: filename });
      await pool.query('UPDATE ticketsmodule_procurement SET payload=$1, updated_at=NOW() WHERE id=$2', [pl, localId]);
    }
  } catch (e) { /* имя-кэш не критичен */ }
  if (codeToKey[fieldCode] === 'pay') {
    try {
      const ctx = await getRequestContext(localId);
      const { notifyPerson, emailHtml } = require('./procurement-notify');
      const t = ctx.title || ('#' + ctx.itemId);
      // Уведомляем инициатора закупки И согласующего (кто утверждал закупку).
      const targets = [...new Set([ctx.creatorBid, ctx.approverBid].filter(Boolean).map(String))];
      for (const uid of targets) {
        const tg = `💳 <b>Оплата закупки проведена</b>\n📋 ${esc(t)}\nПриложено подтверждение оплаты.\n<a href="${dashUrl()}">Открыть</a>`;
        const html = emailHtml({ title: 'Оплата закупки проведена', color: '#0e7c3f', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')]], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
        await notifyPerson(uid, { reason: 'Оплата приложена', tgText: tg, subject: 'Оплата закупки проведена #' + ctx.itemId, html, itemId: ctx.itemId });
      }
    } catch (e) { /* уведомление best-effort */ }
  }
  return { ok: true };
}

// Согласование закупки: статус + утверждающий + комментарий. Уведомляет создателя
// о решении, а при «Согласовано» — главбуха о необходимости приложить оплату.
async function setApproval(localId, status, approverId, comment) {
  const ctx = await getRequestContext(localId);
  const now = new Date().toISOString();
  const myYes = String(status) === APPROVE_YES;
  // Считываем список согласующих и уже накопленные решения.
  const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const pl = (rows[0] && rows[0].payload) || {};
  let approvers = Array.isArray(pl.apApprovers) && pl.apApprovers.length
    ? pl.apApprovers.map(String)
    : (pl.apApprover ? [String(pl.apApprover)] : []);
  const decider = approverId ? String(approverId) : (approvers[0] || null);
  // Если решающий не в списке (напр. руководитель зашёл сам) — добавляем его.
  if (decider && !approvers.includes(decider)) approvers = approvers.concat(decider);
  const decisions = Object.assign({}, pl.apDecisions);
  if (decider) decisions[decider] = { status: String(status), comment: comment || '', at: now, name: USERS[decider] || ('#' + decider) };

  // Итог: достаточно согласования ЛЮБОГО из указанных — тогда закупка согласована.
  // Отклонена — только если ВСЕ указанные отклонили. Пока никто не согласовал и
  // кто-то ещё не решил — ждём.
  const list = approvers.length ? approvers : (decider ? [decider] : []);
  const anyYes = list.some(id => decisions[id] && String(decisions[id].status) === APPROVE_YES);
  const allDecided = list.length > 0 && list.every(id => decisions[id]);
  const overallApproved = anyYes;
  const overallRejected = !anyYes && allDecided;
  const finalDecided = overallApproved || overallRejected;
  const pendingIds = list.filter(id => !decisions[id]);

  // Bitrix: пишем утверждающего/комментарий; статус «да» — когда согласовал любой,
  // «нет» — когда все отклонили; иначе поле статуса не трогаем (шлюз оплаты закрыт).
  const fields = {};
  if (decider) fields[F.preApprover] = decider;
  if (comment != null) fields[F.preApproveComment] = comment;
  if (overallApproved) fields[F.preApprove] = APPROVE_YES;
  else if (overallRejected) fields[F.preApprove] = String(status);
  await b24('crm.item.update', { entityTypeId: ENTITY, id: ctx.itemId, fields });

  // Локальное состояние.
  try {
    pl.apApprovers = list;
    pl.apDecisions = decisions;
    if (decider) pl.apApprover = decider;
    pl.apDecided = finalDecided;
    pl.apRequested = !finalDecided;
    if (finalDecided) pl.apDecidedAt = now; else delete pl.apDecidedAt;
    await pool.query('UPDATE ticketsmodule_procurement SET payload=$1, updated_at=NOW() WHERE id=$2', [pl, localId]);
  } catch (e) { /* флаг не критичен */ }

  const { notifyPerson, emailHtml } = require('./procurement-notify');
  const approved = overallApproved;
  const t = ctx.title || ('#' + ctx.itemId);
  const myName = decider ? (USERS[decider] || ('#' + decider)) : '—';
  // Строка «кто как решил» для писем.
  const decisionLines = list.map(id => {
    const dd = decisions[id];
    const nm = USERS[id] || ('#' + id);
    if (!dd) return `${nm}: ожидает`;
    return `${nm}: ${String(dd.status) === APPROVE_YES ? 'согласовал' : 'отклонил'}${dd.at ? ' (' + fmtWhen(dd.at) + ')' : ''}${dd.comment ? ' — ' + dd.comment : ''}`;
  }).join('; ');

  // 1) уведомить создателя.
  if (ctx.creatorBid) {
    if (finalDecided) {
      const verdict = approved ? 'согласована' : 'отклонена';
      const tg = `${approved ? '✅' : '⛔'} <b>Закупка ${verdict}</b>\n📋 ${esc(t)}\n👥 ${esc(decisionLines)}\n<a href="${dashUrl()}">Открыть</a>`;
      const html = emailHtml({ title: `Закупка ${verdict}`, color: approved ? '#0e7c3f' : '#b91c1c', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ['Решения согласующих', decisionLines], ...(comment ? [['Последний комментарий', comment]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(ctx.creatorBid, { reason: 'Решение по согласованию', tgText: tg, subject: `Закупка ${verdict} #${ctx.itemId}`, html, itemId: ctx.itemId });
    } else {
      // частичное согласование — сообщаем прогресс.
      const remain = pendingIds.map(id => USERS[id] || ('#' + id)).join(', ');
      const tg = `📝 <b>Промежуточное согласование</b>\n📋 ${esc(t)}\n👤 ${esc(myName)} — ${myYes ? 'согласовал' : 'решил'}${comment ? `: ${esc(comment)}` : ''}\n⏳ Ждём: ${esc(remain || '—')}\n<a href="${dashUrl()}">Открыть</a>`;
      const html = emailHtml({ title: 'Промежуточное согласование', color: '#d97706', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ['Решения', decisionLines], ['Ещё не решили', remain || '—']], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(ctx.creatorBid, { reason: 'Промежуточное согласование', tgText: tg, subject: `Согласование закупки #${ctx.itemId}: ${myName} — ${myYes ? 'да' : 'решение'}`, html, itemId: ctx.itemId });
    }
  }
  // 2) если согласовано ВСЕМИ — передать бухгалтеру на оплату (назначенному или главбуху)
  if (approved) {
    const chief = ctx.accountantBid || chiefAccountantId();
    if (chief) {
      const tg = `💰 <b>Требуется оплата закупки</b>\n📋 ${esc(t)}\nЗакупка согласована. Счёт на оплату во вложении. Приложите «Подтверждение оплаты».\n<a href="${dashUrl()}">Открыть в дашборде</a>${ctx.itemUrl ? ` · <a href="${ctx.itemUrl}">в Битриксе</a>` : ''}`;
      const html = emailHtml({ title: 'Требуется оплата закупки', color: '#0f766e', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(ctx.dealId ? [['Сделка', '#' + ctx.dealId]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      const attachments = await slotAttachments(localId, 'invoice');
      await notifyPerson(chief, { reason: 'Запрос оплаты', tgText: tg, subject: 'Требуется оплата закупки #' + ctx.itemId, html, itemId: ctx.itemId, attachments });
    }
  }
  return { ok: true, approved, rejected: overallRejected, pending: !finalDecided, remaining: pendingIds.length };
}

// ── Создание заявки: локальная строка + элемент 1066 ────────────────────────
// bitrixUserId — Bitrix-id менеджера склада (ответственный). Источник —
// «Внутренний запрос» (резолвится в мете). Всё, что ввёл менеджер, садится в
// соответствующие поля 1066. Тегируем через xmlId, чтобы дашборд показывал своё.
async function createRequest(payload, bitrixUserId) {
  await ensureSchema();
  const meta = await getMeta();
  const title = (payload.title && String(payload.title).trim()) || 'Закуп доп оборудования';
  // Bitrix-id инициатора — чтобы уведомления доходили, даже если аккаунт дашборда
  // не привязан к Bitrix (тогда берём ответственного, выбранного в форме).
  payload.initiatorBid = bitrixUserId || payload.assigned || null;

  const fields = { categoryId: CATEGORY, opened: 'Y', title };
  // Ответственный: выбранный в форме, иначе — текущий пользователь (менеджер склада).
  const assigned = payload.assigned || bitrixUserId;
  if (assigned) fields[F.assigned] = assigned;
  // Источник: выбранный в форме, иначе — «Внутренний запрос».
  const source = payload.source || meta.internalSourceId;
  if (source) fields[F.source] = source;
  if (payload.dealId) fields[F.deal] = Number(payload.dealId);
  if (payload.companyId) fields[F.company] = Number(payload.companyId);
  if (payload.opportunity !== undefined && payload.opportunity !== null && payload.opportunity !== '') fields[F.opportunity] = Number(payload.opportunity) || 0;
  if (payload.currency) fields[F.currency] = payload.currency;
  if (payload.vidZakupki) fields[F.vidZakupki] = payload.vidZakupki;
  if (payload.typeKP) fields[F.typeKP] = payload.typeKP;
  if (Array.isArray(payload.proizvoditel) && payload.proizvoditel.length) fields[F.proizvoditel] = payload.proizvoditel;
  if (Array.isArray(payload.pribor) && payload.pribor.length) fields[F.pribor] = payload.pribor;
  if (payload.ustanovka) fields[F.ustanovka] = payload.ustanovka;
  // «Условия оплаты поставщикам» = «100% оплата» при создании с дашборда.
  // На портале ДВА поля (по discovery): заполняем оба, чтобы значение точно село в то,
  // что видно в карточке:
  //  • (УС) iblock  ufCrm10_1746431292 → элемент 83 «100% оплата» (видно в карточке)
  //  • enum         ufCrm10_1744195840932 → 3589 «100% оплата»
  // (УС)-поле/значение можно переопределить через env PROC_OPLATA_FIELD/PROC_OPLATA_VALUE.
  fields[process.env.PROC_OPLATA_FIELD || 'ufCrm10_1746431292'] = process.env.PROC_OPLATA_VALUE || '83';
  fields['ufCrm10_1744195840932'] = '3589';
  if (payload.needKztin) fields[F.needKztin] = payload.needKztin;
  if (payload.kztin) fields[F.kztin] = payload.kztin;
  if (payload.po) fields[F.po] = payload.po;
  if (Array.isArray(payload.serial) && payload.serial.length) fields[F.serial] = payload.serial;
  if (payload.cityCountry) fields[F.cityCountry] = payload.cityCountry;
  // Комментарий + БИН/название компании (если БИН найден, но компании нет в CRM).
  const commentParts = [];
  if (payload.comment) commentParts.push(payload.comment);
  if (payload.bin) commentParts.push('БИН: ' + payload.bin + (payload.companyName && !payload.companyId ? (' · ' + payload.companyName) : ''));
  if (commentParts.length) fields[F.comment] = commentParts.join('\n');

  // локальная строка сперва — чтобы получить id для тега xmlId
  const ins = await pool.query(
    'INSERT INTO ticketsmodule_procurement (deal_id, title, created_by, payload, source_item_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
    [payload.dealId || null, title, payload._createdBy || null, payload, payload.sourceItemId || null]
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
  // Смарт-процесс может авто-генерировать заголовок по шаблону («- - -»),
  // игнорируя title при создании. Форсируем наше название вторым update.
  try {
    const got = String((item && item.title) || '').trim();
    if (!got || /^[\s\-–—]+$/.test(got) || got !== title) {
      await b24('crm.item.update', { entityTypeId: ENTITY, id: item.id, fields: { title } });
      item.title = title;
    }
  } catch (e) { /* best-effort */ }
  await pool.query(
    'UPDATE ticketsmodule_procurement SET bitrix_item_id=$1, stage_id=$2, updated_at=NOW() WHERE id=$3',
    [item.id, item.stageId || null, localId]
  );
  return { localId, bitrixItemId: item.id, stageId: item.stageId || null, itemUrl: itemUrl(item.id) };
}

// ── Авто-создание закупки из завершённого подбора (1058 → 1066) ─────────────
// Триггер (из вебхука ONCRMDYNAMICITEMUPDATE): элемент 1058 на стадии «Заявка
// закрыта» И в поле «Подбор дополнительного оборудования» есть файл. Создаём
// закупку с предзаполнением из сделки, ссылкой на подбор и его файлами. Дедуп
// по source_item_id — одна закупка на один подбор.
async function autoCreateFromService(serviceItemId) {
  if (!serviceItemId) return { skipped: 'no-id' };
  await ensureSchema();
  const { result } = await b24('crm.item.get', { entityTypeId: SERVICE_ENTITY, id: serviceItemId });
  const item = (result && result.item) || {};
  if (item.stageId !== SERVICE_FINAL_STAGE) return { skipped: 'stage', stage: item.stageId };
  if (!fileNonEmpty(item[SERVICE_DOPY_FIELD])) return { skipped: 'no-dopy' };
  // дедуп
  const { rows: ex } = await pool.query('SELECT id FROM ticketsmodule_procurement WHERE source_item_id=$1', [serviceItemId]);
  if (ex.length) return { skipped: 'dup', localId: ex[0].id };

  const dealId = (item.parentId2 ? Number(item.parentId2) : null) || parseDealRef(item[SERVICE_PARENT_DEAL_FIELD]);
  let title = item.title || '';
  let companyId = item.companyId ? Number(item.companyId) : null;
  if (dealId) {
    try {
      const { result: dr } = await b24('crm.deal.get', { id: dealId });
      if (dr) { title = dr.TITLE || title; if (!companyId && dr.COMPANY_ID) companyId = Number(dr.COMPANY_ID); }
    } catch (e) { /* fallback на данные 1058 */ }
  }
  const wm = warehouseManagerId();
  const payload = {
    dealId, companyId,
    title: title ? ('Доп оборудование — ' + title) : 'Доп оборудование (из подбора)',
    vidZakupki: VID_POSTAVKA_KLIENTU,   // «Для поставки клиенту»
    assigned: wm,                       // ответственный — менеджер склада (Нурмаганбетов)
    sourceItemId: serviceItemId,
  };
  const out = await createRequest(payload, wm);

  // Обратная связь: привязать созданную закупку к элементу подбора (1058) — best-effort
  try { await b24('crm.item.update', { entityTypeId: SERVICE_ENTITY, id: serviceItemId, fields: { [SERVICE_ZAKUPKI_FIELD]: out.bitrixItemId } }); } catch (e) { /* необязательно */ }

  // Уведомить менеджера склада о новой авто-заявке — best-effort
  try {
    if (wm) {
      const { notifyPerson, emailHtml } = require('./procurement-notify');
      const tg = `🆕 <b>Авто-заявка на закуп допов</b>\n📋 ${esc(payload.title)}${dealId ? `\n🔗 Сделка #${dealId}` : ''}\nСоздана из завершённого подбора. Файлы допов внутри.\n<a href="${dashUrl()}">Открыть в дашборде</a>`;
      const html = emailHtml({ title: 'Авто-заявка на закуп допов', color: '#7c3aed', lines: [['Заявка', '#' + out.bitrixItemId + ' — ' + payload.title], ...(dealId ? [['Сделка', '#' + dealId]] : [])], itemUrl: out.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(wm, { reason: 'Авто-заявка из подбора', tgText: tg, subject: 'Авто-заявка на закуп допов #' + out.bitrixItemId, html, itemId: out.bitrixItemId });
    }
  } catch (e) { /* best-effort */ }

  console.log(`🆕 procurement: авто-заявка #${out.bitrixItemId} из подбора 1058 #${serviceItemId}`);
  return { created: true, ...out };
}

// ── Файлы документов (множественные, локальный источник правды) ──────────────
const SLOT_KEYS = ['invoice', 'pay', 'poa', 'contract', 'warranty'];
const SLOT_LABELS = { invoice: 'Счет на оплату', pay: 'Подтверждение оплаты', poa: 'Доверенность', contract: 'Накладная', warranty: 'Гарантийный сертификат' };
function userFacing(msg) { const e = new Error(msg); e.userFacing = true; return e; }

// Выгрузка байтов файла из Битрикса. Через node-fetch (как в discovery, где
// скачивание подтвердилось) + .buffer() — надёжнее глобального fetch на Railway.
const _nodeFetch = (() => { try { return require('node-fetch'); } catch (e) { return null; } })();
async function fetchUrlBuffer(url) {
  const fn = _nodeFetch || _fetch;
  if (!fn || !url) return null;
  try {
    const r = await fn(url);
    if (!r.ok) { console.error('fetchUrlBuffer HTTP', r.status); return null; }
    if (typeof r.buffer === 'function') return await r.buffer();
    return Buffer.from(await r.arrayBuffer());
  } catch (e) { console.error('fetchUrlBuffer:', e.message); return null; }
}

// Файловые объекты произвольного файлового поля: [{ id, urlMachine }].
async function bitrixFieldFiles(itemId, code, itemCache) {
  if (!code) return [];
  let item = itemCache;
  if (!item) { const { result } = await b24('crm.item.get', { entityTypeId: ENTITY, id: itemId }); item = (result && result.item) || {}; }
  const v = item[code];
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return arr.map(f => ({ id: Number(f.id || f.ID), urlMachine: f.urlMachine || f.downloadUrl || f.url || null }));
}
async function bitrixSlotFiles(itemId, slot, itemCache) {
  const docFields = await resolveDocFields();
  return bitrixFieldFiles(itemId, docFields[slot], itemCache);
}

// Код файлового поля «ТТН» (резолв по названию, кэш 30 мин).
let _ttnField = null, _ttnAt = 0;
async function resolveTtnField() {
  if (_ttnField !== null && Date.now() - _ttnAt < 30 * 60 * 1000) return _ttnField;
  let code = process.env.PROC_TTN_FIELD || '';
  try {
    const { result } = await b24('crm.item.fields', { entityTypeId: ENTITY });
    const fields = (result && result.fields) || {};
    const fileFields = Object.entries(fields).filter(([, f]) => String(f.type).toLowerCase() === 'file');
    const codeNum = c => { const m = String(c).match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; };
    const hits = fileFields.filter(([, f]) => /(^|\W)ттн(\W|$)|товарно.*транспортн/i.test(String(f.title || '').trim()));
    if (hits.length) { hits.sort((a, b) => codeNum(b[0]) - codeNum(a[0])); code = hits[0][0]; }
  } catch (e) { console.error('resolveTtnField:', e.message); }
  _ttnField = code; _ttnAt = Date.now();
  return _ttnField;
}
// Записать НАБОР ТТН (формат B) в поле «ТТН» конкретной закупки (1066), best-effort.
// pairs — [[имя, base64], ...] всех ТТН, которые должны лежать в этой закупке.
async function pushTtnPairs(itemId, pairs) {
  try {
    const code = await resolveTtnField(); if (!code || !itemId) return;
    await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [code]: (pairs && pairs.length) ? pairs : '' } });
  } catch (e) { console.error('pushTtnPairs:', e.message); }
}

// Пары [имя, base64] для всех текущих файлов слота (для записи в поле Битрикса
// форматом B — единственным рабочим). Байты берём из локального кэша, а если
// вычищены — тянем из Битрикса по порядку (индексу).
async function slotFilePairs(localId, slot) {
  const itemId = await itemIdOf(localId);
  const { rows } = await pool.query(
    'SELECT id, filename, content_b64 FROM ticketsmodule_procurement_files WHERE request_id=$1 AND slot=$2 ORDER BY id', [localId, slot]);
  let bx = null;
  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let b64 = r.content_b64;
    if (!b64) {
      if (bx === null) { try { bx = await bitrixSlotFiles(itemId, slot); } catch (e) { bx = []; } }
      const f = bx[i];
      if (f && f.urlMachine) { const buf = await fetchUrlBuffer(f.urlMachine); if (buf) b64 = buf.toString('base64'); }
    }
    if (b64) pairs.push([r.filename || 'file', b64]);
  }
  return pairs;
}
// Синхронизировать поле слота в Битриксе ВСЕМ набором (формат B: массив пар).
async function pushSlotFull(localId, slot) {
  try {
    const docFields = await resolveDocFields();
    const code = docFields[slot]; if (!code) return;
    const itemId = await itemIdOf(localId);
    const pairs = await slotFilePairs(localId, slot);
    await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [code]: pairs.length ? pairs : '' } });
  } catch (e) { console.error('pushSlotFull', slot, e.message); }
}

// Добавить файл в слот: в ЦУПе — метаданные + временные байты; поле Битрикса
// пересобираем ВСЕМ набором (дописать по id Битрикс не умеет). Возвращает { id, first }.
async function addFile(localId, slot, { filename, mime, base64, warehouse, acceptDate, comment } = {}, uploadedBy) {
  await ensureSchema();
  if (!SLOT_KEYS.includes(slot)) throw new Error('Недопустимый слот файла');
  if (!base64) throw userFacing('Не приложен файл');
  const docFields = await resolveDocFields();
  const code = docFields[slot];
  if (!code) throw userFacing('В Битриксе не найдено поле для «' + (SLOT_LABELS[slot] || slot) + '»');
  const before = await pool.query('SELECT COUNT(*)::int AS n FROM ticketsmodule_procurement_files WHERE request_id=$1 AND slot=$2', [localId, slot]);
  const first = (before.rows[0].n || 0) === 0;
  // Байты кладём во ВРЕМЕННОЕ поле content_b64 — чтобы письма прикладывали файл
  // надёжно и чтобы пересобирать набор без обращения к Битриксу. Через 3 дня чистятся.
  const ins = await pool.query(
    `INSERT INTO ticketsmodule_procurement_files (request_id, slot, filename, mime, content_b64, warehouse, accept_date, comment, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [localId, slot, filename || 'file', mime || null, base64 || null, warehouse || null, acceptDate || null, comment || null, uploadedBy || null]);
  // Пересобираем поле Битрикса всем набором (формат B).
  await pushSlotFull(localId, slot);
  // Уведомление об оплате шлём НЕ при загрузке платёжки, а при переходе на
  // «Ожидание товара» — чтобы в одном письме были и платёжка, и доверенность
  // (см. moveStage → stageKey==='waiting').
  // Добавили/изменили документ (не первый файл слота) → досылаем его повторно
  // с уведомлением. Первый файл покрывают уведомления смены стадии.
  if (!first) notifyFileChanged(localId, slot, filename || 'file', base64, uploadedBy).catch(() => {});
  return { id: ins.rows[0].id, first };
}

// Пакетная загрузка нескольких файлов в слот за один вызов: вставляем все
// локально, ОДИН раз пересобираем поле Битрикса (не N раз), одно письмо.
async function addFilesBatch(localId, slot, files, uploadedBy) {
  await ensureSchema();
  if (!SLOT_KEYS.includes(slot)) throw new Error('Недопустимый слот файла');
  files = (files || []).filter(f => f && f.base64);
  if (!files.length) throw userFacing('Файлы не приложены');
  const code = (await resolveDocFields())[slot];
  if (!code) throw userFacing('В Битриксе не найдено поле для «' + (SLOT_LABELS[slot] || slot) + '»');
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM ticketsmodule_procurement_files WHERE request_id=$1 AND slot=$2', [localId, slot])).rows[0].n || 0;
  for (const f of files) {
    await pool.query(
      `INSERT INTO ticketsmodule_procurement_files (request_id, slot, filename, mime, content_b64, warehouse, accept_date, comment, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [localId, slot, f.filename || 'file', f.mime || null, f.base64, f.warehouse || null, f.acceptDate || null, f.comment || null, uploadedBy || null]);
  }
  await pushSlotFull(localId, slot); // один раз
  // Досылаем уведомление, если добавили сверх первого файла слота.
  if (before > 0 || files.length > 1) {
    const atts = files.slice(before > 0 ? 0 : 1).map(f => ({ filename: f.filename || 'file', content: f.base64 }));
    if (atts.length) notifyFilesChanged(localId, slot, atts, { byBid: uploadedBy }).catch(() => {});
  }
  return { count: files.length, first: before === 0 };
}

// Уведомление «документ(ы) добавлен(ы)/изменён(ы)» — с вложением самих файлов.
// attachments: [{ filename, content(base64) }]. Получатели зависят от типа документа.
async function notifyFilesChanged(localId, slot, attachments, opts = {}) {
  try {
    if (!attachments || !attachments.length) return;
    const ctx = await getRequestContext(localId);
    const { notifyPerson, emailHtml } = require('./procurement-notify');
    const label = SLOT_LABELS[slot] || slot;
    const t = ctx.title || ('#' + ctx.itemId);
    const chief = ctx.accountantBid || chiefAccountantId();
    const recipMap = {
      invoice: [ctx.approverBid, chief],
      pay: [ctx.creatorBid, ctx.approverBid],
      poa: [ctx.creatorBid, ctx.approverBid],
      contract: [ctx.approverBid, chief],
      warranty: [ctx.approverBid, chief],
    };
    const recip = recipMap[slot] || [ctx.creatorBid, ctx.approverBid];
    const names = attachments.map(a => a.filename).filter(Boolean).join(', ');
    const targets = [...new Set(recip.filter(Boolean).map(String))];
    // Кто приложил + когда — для подробного уведомления (#4).
    const byName = opts.byBid ? (USERS[opts.byBid] || ('#' + opts.byBid)) : null;
    const whenStr = fmtWhen(new Date().toISOString());
    const byLine = byName ? `\n👤 Приложил: ${esc(byName)} · ${esc(whenStr)}` : `\n🕒 ${esc(whenStr)}`;
    for (const uid of targets) {
      const tg = `📎 <b>Документ обновлён: «${esc(label)}»</b>\n📋 ${esc(t)}\nДобавлено файлов: ${attachments.length} (во вложении):\n${esc(names)}${byLine}\n<a href="${dashUrl()}">Открыть</a>`;
      const html = emailHtml({ title: `Документ обновлён: «${label}»`, color: '#7c3aed', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ['Документ', label], ['Файлы', names], ['Количество', String(attachments.length)], ...(byName ? [['Приложил', byName]] : []), ['Когда', whenStr]], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(uid, { reason: 'Документ обновлён', tgText: tg, subject: `Документ обновлён: ${label} · закупка #${ctx.itemId}`, html, itemId: ctx.itemId, attachments });
    }
  } catch (e) { /* best-effort */ }
}
// Совместимость: одиночный файл.
function notifyFileChanged(localId, slot, filename, base64, byBid) {
  return notifyFilesChanged(localId, slot, base64 ? [{ filename: filename || 'file', content: base64 }] : [], { byBid });
}

// Уведомление об откате стадии назад (с причиной) — инициатору, согласующему, бухгалтеру.
async function notifyRollback(localId, fromLabel, toLabel, reason, byName) {
  try {
    const ctx = await getRequestContext(localId);
    const { notifyPerson, emailHtml } = require('./procurement-notify');
    const t = ctx.title || ('#' + ctx.itemId);
    const targets = [...new Set([ctx.creatorBid, ctx.approverBid, ctx.accountantBid || chiefAccountantId()].filter(Boolean).map(String))];
    for (const uid of targets) {
      const tg = `↩ <b>Откат стадии закупки</b>\n📋 ${esc(t)}\n${esc(fromLabel)} → ${esc(toLabel)}${byName ? ` · ${esc(byName)}` : ''}\n💬 Причина: ${esc(reason || '—')}\n<a href="${dashUrl()}">Открыть</a>`;
      const html = emailHtml({ title: 'Откат стадии закупки', color: '#d97706', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ['Откат', fromLabel + ' → ' + toLabel], ...(byName ? [['Кто', byName]] : []), ['Причина', reason || '—']], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(uid, { reason: 'Откат стадии', tgText: tg, subject: `Откат стадии закупки #${ctx.itemId}`, html, itemId: ctx.itemId });
    }
  } catch (e) { /* best-effort */ }
}

// Уведомление «Оплата проведена» (инициатору и согласующему) с вложением
// платёжки и доверенности. Вызывается при переходе на «Ожидание товара».
async function notifyPaymentDone(localId, byBid) {
  try {
    const ctx = await getRequestContext(localId);
    const { notifyPerson, emailHtml } = require('./procurement-notify');
    const t = ctx.title || ('#' + ctx.itemId);
    const attachments = await slotAttachments(localId, ['pay', 'poa']);
    const targets = [...new Set([ctx.creatorBid, ctx.approverBid].filter(Boolean).map(String))];
    const byName = byBid ? (USERS[byBid] || ('#' + byBid)) : null;
    const whenStr = fmtWhen(new Date().toISOString());
    const hasPoa = attachments.length > 1;
    for (const uid of targets) {
      const tg = `💳 <b>Оплата закупки проведена</b>\n📋 ${esc(t)}\nПриложено подтверждение оплаты${hasPoa ? ' и доверенность' : ''} (во вложении).${byName ? `\n👤 Провёл: ${esc(byName)} · ${esc(whenStr)}` : `\n🕒 ${esc(whenStr)}`}\n<a href="${dashUrl()}">Открыть</a>`;
      const html = emailHtml({ title: 'Оплата закупки проведена', color: '#0e7c3f', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ['Вложения', hasPoa ? 'подтверждение оплаты + доверенность' : 'подтверждение оплаты'], ...(byName ? [['Провёл оплату', byName]] : []), ['Когда', whenStr]], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(uid, { reason: 'Оплата приложена', tgText: tg, subject: 'Оплата закупки проведена #' + ctx.itemId, html, itemId: ctx.itemId, attachments });
    }
  } catch (e) { /* best-effort */ }
}

// Файлы заявки, сгруппированные по слотам (для дашборда).
async function filesFor(localId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT id, slot, filename, mime, warehouse, accept_date, comment, uploaded_by, uploaded_at
       FROM ticketsmodule_procurement_files WHERE request_id=$1 ORDER BY id`, [localId]);
  const bySlot = { invoice: [], pay: [], poa: [], contract: [], warranty: [] };
  for (const r of rows) {
    (bySlot[r.slot] = bySlot[r.slot] || []).push({
      id: r.id, name: r.filename, mime: r.mime,
      warehouse: r.warehouse || '', acceptDate: r.accept_date ? String(r.accept_date).slice(0, 10) : '', comment: r.comment || '',
      uploadedByName: r.uploaded_by ? (USERS[r.uploaded_by] || ('#' + r.uploaded_by)) : null,
      uploadedAt: r.uploaded_at,
      url: `/api/procurement/${localId}/files/${r.id}/download`,
    });
  }
  return bySlot;
}

// Вложения для письма: [{ filename, content(base64) }].
// Байты — из локального кэша; если вычищены, тянем из Битрикса по порядку (индексу).
async function slotAttachments(localId, slots) {
  const arr = Array.isArray(slots) ? slots : [slots];
  const out = [];
  const itemId = await itemIdOf(localId);
  for (const slot of arr) {
    const { rows } = await pool.query(
      'SELECT id, filename, content_b64 FROM ticketsmodule_procurement_files WHERE request_id=$1 AND slot=$2 ORDER BY id', [localId, slot]);
    if (!rows.length) continue;
    let bx = null;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.content_b64) { out.push({ filename: r.filename || 'file', content: r.content_b64 }); continue; }
      if (bx === null) { try { bx = await bitrixSlotFiles(itemId, slot); } catch (e) { bx = []; } }
      const f = bx[i];
      if (!f || !f.urlMachine) continue;
      const buf = await fetchUrlBuffer(f.urlMachine);
      if (buf) out.push({ filename: r.filename || 'file', content: buf.toString('base64') });
    }
  }
  return out;
}

// Байты файла для скачивания из ЦУП — локально если есть, иначе прокси из Битрикса по индексу.
async function getFileBytes(localId, fileId) {
  const { rows } = await pool.query(
    'SELECT slot, filename, mime, content_b64 FROM ticketsmodule_procurement_files WHERE id=$1 AND request_id=$2', [fileId, localId]);
  if (!rows.length) return null;
  const r = rows[0];
  if (r.content_b64) return { filename: r.filename || 'file', mime: r.mime || 'application/octet-stream', buffer: Buffer.from(r.content_b64, 'base64') };
  const { rows: sl } = await pool.query('SELECT id FROM ticketsmodule_procurement_files WHERE request_id=$1 AND slot=$2 ORDER BY id', [localId, r.slot]);
  const idx = sl.findIndex(x => Number(x.id) === Number(fileId));
  const itemId = await itemIdOf(localId);
  let files = [];
  try { files = await bitrixSlotFiles(itemId, r.slot); } catch (e) { return null; }
  const match = files[idx];
  if (!match || !match.urlMachine) return null;
  const buf = await fetchUrlBuffer(match.urlMachine);
  if (!buf) return null;
  return { filename: r.filename || 'file', mime: r.mime || 'application/octet-stream', buffer: buf };
}

// Чистка временных байтов файлов закупок старше 3 дней (файлы живут в Битриксе).
let _lastPrune = 0;
function pruneOldFileBytes() {
  const now = Date.now();
  if (now - _lastPrune < 60 * 60 * 1000) return; // не чаще раза в час
  _lastPrune = now;
  pool.query("UPDATE ticketsmodule_procurement_files SET content_b64=NULL WHERE content_b64 IS NOT NULL AND uploaded_at < NOW() - INTERVAL '3 days'").catch(() => {});
}

// Удалить файл слота: убираем из поля Битрикса (пересобираем набор без него) + локально.
async function removeFile(localId, fileId) {
  const { rows } = await pool.query('SELECT slot FROM ticketsmodule_procurement_files WHERE id=$1 AND request_id=$2', [fileId, localId]);
  await pool.query('DELETE FROM ticketsmodule_procurement_files WHERE id=$1 AND request_id=$2', [fileId, localId]);
  // Пересобираем поле Битрикса оставшимся набором (формат B).
  if (rows.length) await pushSlotFull(localId, rows[0].slot);
  return { ok: true };
}

// Отметка «Полностью принят» (управляет зелёным цветом финального шага).
async function setFullyReceived(localId, value, byBid) {
  const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const pl = (rows[0] && rows[0].payload) || {};
  const was = !!pl.fullyReceived;
  pl.fullyReceived = !!value;
  pl.fullyReceivedAt = value ? new Date().toISOString() : null;
  pl.fullyReceivedBy = value ? (byBid ? (USERS[byBid] || ('#' + byBid)) : null) : null;
  await pool.query('UPDATE ticketsmodule_procurement SET payload=$1, updated_at=NOW() WHERE id=$2', [pl, localId]);
  // Полная приёмка (переход false→true) = реальное завершение → уведомляем
  // согласующего и главбуха с вложением накладной и гарантийного сертификата.
  if (value && !was) {
    try {
      const ctx = await getRequestContext(localId);
      const { notifyPerson, emailHtml } = require('./procurement-notify');
      const t = ctx.title || ('#' + ctx.itemId);
      const attachments = await slotAttachments(localId, ['contract', 'warranty']);
      const targets = [...new Set([ctx.approverBid, ctx.accountantBid || chiefAccountantId()].filter(Boolean).map(String))];
      for (const uid of targets) {
        const tg = `📦 <b>Товар принят полностью</b>\n📋 ${esc(t)}\nЗакупка завершена — товар получен (накладная и гарантийный сертификат во вложении).\n<a href="${dashUrl()}">Открыть</a>`;
        const html = emailHtml({ title: 'Товар принят полностью', color: '#0e7c3f', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(ctx.dealId ? [['Сделка', '#' + ctx.dealId]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
        await notifyPerson(uid, { reason: 'Товар принят', tgText: tg, subject: 'Товар принят #' + ctx.itemId, html, itemId: ctx.itemId, attachments });
      }
    } catch (e) { /* уведомление best-effort */ }
  }
  return { ok: true, fullyReceived: !!value };
}

// ── Отгрузка по сделке (ТТН + «доотправка») ──────────────────────────────────
async function getDealShipment(dealId) {
  await ensureSchema();
  dealId = Number(dealId);
  const st = await pool.query('SELECT closed_at, closed_by FROM ticketsmodule_procurement_deal_ship WHERE deal_id=$1', [dealId]);
  const row = st.rows[0] || null;
  const sf = await pool.query(
    'SELECT id, item_id, filename FROM ticketsmodule_procurement_ship_files WHERE deal_id=$1 ORDER BY id', [dealId]);
  const mainFiles = [], byItem = {};
  for (const f of sf.rows) {
    const rec = { id: f.id, name: f.filename, url: `/api/procurement/deal/${dealId}/ship-file/${f.id}/download` };
    if (f.item_id == null) mainFiles.push(rec);
    else (byItem[f.item_id] = byItem[f.item_id] || []).push(rec);
  }
  return {
    closed: !!(row && row.closed_at),
    closedAt: row ? row.closed_at : null,
    closedByName: row && row.closed_by ? (USERS[row.closed_by] || ('#' + row.closed_by)) : null,
    files: mainFiles,
    reshipByItem: byItem,
  };
}

// Главная закупка сделки — самая ранняя (наименьший id): её сейлз создаёт
// автоматически в начале. Основную ТТН пишем именно в неё.
async function findMainProcurementItem(dealId) {
  try {
    const { result } = await b24('crm.item.list', {
      entityTypeId: ENTITY, filter: { parentId2: Number(dealId) },
      select: ['id'], order: { id: 'ASC' },
    });
    const items = (result && result.items) || [];
    return items.length ? Number(items[0].id) : null;
  } catch (e) { console.error('findMainProcurementItem:', e.message); return null; }
}

async function addShipFile(dealId, itemId, { filename, mime, base64 } = {}, byBid) {
  await ensureSchema();
  if (!base64) throw userFacing('Не приложен файл ТТН');
  const ins = await pool.query(
    `INSERT INTO ticketsmodule_procurement_ship_files (deal_id, item_id, filename, mime, content_b64, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [Number(dealId), itemId ? Number(itemId) : null, filename || 'ТТН', mime || null, base64, byBid || null]);
  // ТТН в поле «ТТН» Битрикса: доотправка → в свою закупку; основная (без itemId)
  // → в главную закупку сделки. Пишем ВСЕМ набором (формат B). Best-effort.
  (async () => {
    try {
      const target = itemId ? Number(itemId) : await findMainProcurementItem(dealId);
      if (!target) return;
      const { rows } = itemId
        ? await pool.query('SELECT filename, content_b64 FROM ticketsmodule_procurement_ship_files WHERE deal_id=$1 AND item_id=$2 ORDER BY id', [Number(dealId), Number(itemId)])
        : await pool.query('SELECT filename, content_b64 FROM ticketsmodule_procurement_ship_files WHERE deal_id=$1 AND item_id IS NULL ORDER BY id', [Number(dealId)]);
      const pairs = rows.filter(r => r.content_b64).map(r => [r.filename || 'ТТН', r.content_b64]);
      await pushTtnPairs(target, pairs);
    } catch (e) { console.error('ship ttn push:', e.message); }
  })().catch(() => {});
  return { id: ins.rows[0].id };
}

// Зафиксировать «всё отправлено клиенту»: требуется хотя бы одна ТТН.
async function closeDealShipment(dealId, ttnFiles, byBid) {
  await ensureSchema();
  dealId = Number(dealId);
  const files = Array.isArray(ttnFiles) ? ttnFiles.filter(f => f && f.base64) : [];
  const existing = await pool.query('SELECT COUNT(*)::int AS n FROM ticketsmodule_procurement_ship_files WHERE deal_id=$1 AND item_id IS NULL', [dealId]);
  if (!files.length && (existing.rows[0].n || 0) === 0) throw userFacing('Приложите ТТН — без неё нельзя зафиксировать отгрузку.');
  for (const f of files) await addShipFile(dealId, null, { filename: f.filename, mime: f.mime, base64: f.base64 }, byBid);
  await pool.query(
    `INSERT INTO ticketsmodule_procurement_deal_ship (deal_id, closed_at, closed_by) VALUES ($1, NOW(), $2)
     ON CONFLICT (deal_id) DO UPDATE SET closed_at=NOW(), closed_by=$2`, [dealId, byBid || null]);
  return { ok: true };
}

async function reopenDealShipment(dealId) {
  await ensureSchema();
  await pool.query('UPDATE ticketsmodule_procurement_deal_ship SET closed_at=NULL WHERE deal_id=$1', [Number(dealId)]);
  return { ok: true };
}

async function getShipFileBytes(dealId, fileId) {
  const { rows } = await pool.query(
    'SELECT filename, mime, content_b64 FROM ticketsmodule_procurement_ship_files WHERE id=$1 AND deal_id=$2', [Number(fileId), Number(dealId)]);
  if (!rows.length || !rows[0].content_b64) return null;
  return { filename: rows[0].filename || 'ТТН', mime: rows[0].mime || 'application/octet-stream', buffer: Buffer.from(rows[0].content_b64, 'base64') };
}

async function removeShipFile(dealId, fileId) {
  await pool.query('DELETE FROM ticketsmodule_procurement_ship_files WHERE id=$1 AND deal_id=$2', [Number(fileId), Number(dealId)]);
  return { ok: true };
}

// ── Действия, за которые отвечает пользователь (для бейджа на иконке PWA) ─────
// Считаем только по локальной таблице (быстро, без обращений к Битриксу):
//  • согласование ждёт меня (я в списке согласующих и ещё не решил);
//  • оплата ждёт меня (я назначенный бухгалтер / главбух, стадия «Оплата»);
//  • приёмка ждёт меня (я ответственный, стадия «Ожидание товара»).
async function pendingActionsFor(bid) {
  await ensureSchema();
  bid = String(bid || '');
  if (!bid) return { count: 0, items: [] };
  const paymentStage = (FLOW.find(s => s.key === 'payment') || {}).bitrix;
  const waitingStage = (FLOW.find(s => s.key === 'waiting') || {}).bitrix;
  const chief = String(chiefAccountantId() || '');
  let rows = [];
  try {
    ({ rows } = await pool.query('SELECT id, bitrix_item_id, title, stage_id, accountant_bid, payload FROM ticketsmodule_procurement'));
  } catch (e) { return { count: 0, items: [] }; }
  const items = [];
  for (const r of rows) {
    const pl = r.payload || {};
    // 1) согласование ждёт меня
    const apprs = Array.isArray(pl.apApprovers) ? pl.apApprovers.map(String) : (pl.apApprover ? [String(pl.apApprover)] : []);
    const decided = pl.apDecisions || {};
    if (pl.apRequested && !pl.apDecided && apprs.includes(bid) && !decided[bid]) {
      items.push({ localId: r.id, title: r.title, kind: 'approve', label: 'Требуется согласование' });
      continue;
    }
    // 2) оплата ждёт меня
    if (paymentStage && r.stage_id === paymentStage) {
      const acc = r.accountant_bid ? String(r.accountant_bid) : chief;
      if (acc && acc === bid) { items.push({ localId: r.id, title: r.title, kind: 'pay', label: 'Требуется оплата' }); continue; }
    }
    // 3) приёмка ждёт меня (ответственный склад)
    if (waitingStage && r.stage_id === waitingStage) {
      const assignee = String(pl.assigned || pl.initiatorBid || '');
      if (assignee && assignee === bid) { items.push({ localId: r.id, title: r.title, kind: 'receive', label: 'Ожидает приёмки' }); }
    }
  }
  return { count: items.length, items };
}

module.exports = { ENTITY, CATEGORY, TAG_PREFIX, F, DOCS, FLOW, SLOT_KEYS, SLOT_LABELS, getMeta, searchDeals, searchCompanies, resolveBin, listRequests, listByDeal, createRequest, updateRequest, deleteRequest, listDeletions, moveStage, getItemDetail, uploadDoc, addFile, addFilesBatch, filesFor, getFileBytes, removeFile, setFullyReceived, getDealShipment, closeDealShipment, reopenDealShipment, addShipFile, getShipFileBytes, removeShipFile, setApproval, requestApproval, setAccountant, autoCreateFromService, pendingActionsFor, itemUrl, dealUrl };

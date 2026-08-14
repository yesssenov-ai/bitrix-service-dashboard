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
const DOC_INVOICE = 'ufCrm10_1763537277532';   // резерв
const DOC_PAY = 'ufCrm10_1744874990535';       // резерв
const DOC_CONTRACT = 'ufCrm10_1732858619051';  // резерв
const DOC_WARRANTY = process.env.PROC_WARRANTY_FIELD || 'ufCrm10_1732858487739'; // резерв
const APPROVE_YES = '1827';                    // «Согласовано» (поле Согласование предоплаты)
// Слоты загрузки: ключ + подпись (код подтягивается динамически по названию).
const UPLOAD_SLOT_DEFS = [
  { key: 'invoice',  label: 'Счет на оплату',           re: /сч[её]т.*оплат/i,       fallback: DOC_INVOICE },
  { key: 'pay',      label: 'Подтверждение оплаты',      re: /подтвержд.*оплат/i,     fallback: DOC_PAY },
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
  // «Условия оплаты поставщикам (УС)» → «100% оплата». Резолвим и КОД поля, и ID
  // значения по названию. Поле может быть enum (f.items) ИЛИ список/iblock (тогда
  // варианты тянем через lists.element.get). Логируем результат в Railway.
  let oplataDefault = null;
  if (process.env.PROC_OPLATA_FIELD && process.env.PROC_OPLATA_VALUE) {
    oplataDefault = { code: process.env.PROC_OPLATA_FIELD, valueId: String(process.env.PROC_OPLATA_VALUE), label: '100% (env)' };
    console.log('oplataDefault: из env', oplataDefault.code, '=', oplataDefault.valueId);
  } else {
    try {
      let entry = Object.entries(fields).find(([, f]) => /услови.*оплат.*поставщик/i.test(String(f.title || '')));
      if (!entry && fields[F.oplataPostavshikam]) entry = [F.oplataPostavshikam, fields[F.oplataPostavshikam]];
      if (entry) {
        const [code, f] = entry;
        let opts = (Array.isArray(f.items) && f.items.length) ? f.items.map(i => ({ id: String(i.ID), label: String(i.VALUE) })) : [];
        if (!opts.length) { try { opts = await iblockOptions(f); } catch (e) { opts = []; } }
        const hit = opts.find(o => /(^|\D)100\s*%|100\s*процент/i.test(String(o.label)));
        console.log(`oplataDefault: поле=${code} type=${f.type} title="${f.title}" вариантов=${opts.length} → ${hit ? hit.id + ' «' + hit.label + '»' : 'нет 100%'}`);
        if (hit) oplataDefault = { code, valueId: hit.id, label: hit.label };
      } else { console.log('oplataDefault: поле «Условия оплаты поставщикам» не найдено в crm.item.fields'); }
    } catch (e) { console.error('oplataDefault resolve:', e.message); }
  }
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
    oplataDefault,
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
    const tg = `👤 <b>Вы назначены на оплату закупки</b>\n📋 ${esc(t)}\n<a href="${dashUrl()}">Открыть в дашборде</a>${ctx.itemUrl ? ` · <a href="${ctx.itemUrl}">в Битриксе</a>` : ''}`;
    const html = emailHtml({ title: 'Вы назначены на оплату закупки', color: '#0f766e', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')]], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
    await notifyPerson(accountantBid, { reason: 'Назначен бухгалтер', tgText: tg, subject: 'Вы назначены на оплату закупки #' + ctx.itemId, html, itemId: ctx.itemId });
  } catch (e) { /* уведомление best-effort */ }
  return { ok: true };
}

// Отправить закупку на согласование выбранному руководителю (+ уведомить его).
async function requestApproval(localId, approverId) {
  if (!approverId) throw new Error('Не выбран согласующий');
  const ctx = await getRequestContext(localId);
  await b24('crm.item.update', { entityTypeId: ENTITY, id: ctx.itemId, fields: { [F.preApprover]: approverId } });
  // Локальный статус «На согласовании» (в 1066 нет отдельной стадии под это) —
  // сбрасываем прошлое решение, чтобы pill снова показал ожидание.
  try {
    const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
    const pl = (rows[0] && rows[0].payload) || {};
    pl.apRequested = true; pl.apApprover = String(approverId); pl.apDecided = false;
    await pool.query('UPDATE ticketsmodule_procurement SET payload=$1, updated_at=NOW() WHERE id=$2', [pl, localId]);
  } catch (e) { /* флаг не критичен */ }
  const { notifyPerson, emailHtml } = require('./procurement-notify');
  const t = ctx.title || ('#' + ctx.itemId);
  const tg = `🟠 <b>Закупка на согласование</b>\n📋 ${esc(t)}${ctx.dealId ? `\n🔗 Сделка #${ctx.dealId}` : ''}\n\nТребуется ваше согласование.\n<a href="${dashUrl()}">Открыть в дашборде</a>${ctx.itemUrl ? ` · <a href="${ctx.itemUrl}">в Битриксе</a>` : ''}`;
  const html = emailHtml({ title: 'Закупка на согласование', color: '#d97706', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(ctx.dealId ? [['Сделка', '#' + ctx.dealId]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
  await notifyPerson(approverId, { reason: 'Запрос согласования', tgText: tg, subject: 'Закупка на согласование #' + ctx.itemId, html, itemId: ctx.itemId });
  return { ok: true };
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
async function deleteRequest(localId) {
  const { rows } = await pool.query('SELECT bitrix_item_id FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  const itemId = rows[0] && rows[0].bitrix_item_id;
  if (itemId) { try { await b24('crm.item.delete', { entityTypeId: ENTITY, id: itemId }); } catch (e) { console.error('procurement delete item:', e.message); } }
  await pool.query('DELETE FROM ticketsmodule_procurement WHERE id=$1', [localId]);
  return { ok: true };
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
  const [smap, lr] = await Promise.all([
    stageNameMap(),
    pool.query('SELECT bitrix_item_id, id FROM ticketsmodule_procurement WHERE deal_id=$1', [dealId]),
  ]);
  const localByItem = {}; lr.rows.forEach(r => { if (r.bitrix_item_id) localByItem[r.bitrix_item_id] = r.id; });
  let items = [];
  try {
    let start = 0;
    while (true) {
      const { result } = await b24('crm.item.list', {
        entityTypeId: ENTITY, filter: { parentId2: dealId },
        select: ['id', 'title', 'stageId', 'opportunity', 'currencyId', 'xmlId', 'assignedById'], start,
      });
      const batch = (result && result.items) || [];
      items = items.concat(batch);
      const total = result && result.total; start += batch.length;
      if (!batch.length || (total != null && start >= total) || batch.length < 50) break;
      if (start > 2000) break;
    }
  } catch (e) { console.error('listByDeal error:', e.message); }
  return {
    dealId, dealUrl: dealUrl(dealId),
    items: items.map(it => ({
      id: it.id, title: it.title || ('#' + it.id),
      stageId: it.stageId, stageName: smap[it.stageId] || it.stageId,
      sem: SUCCESS_STAGES.test(it.stageId) ? 'ok' : (FAIL_STAGES.test(it.stageId) ? 'fail' : 'work'),
      sum: parseFloat(it.opportunity) || 0, currency: it.currencyId || 'KZT',
      assignedId: it.assignedById || null, assignedName: it.assignedById ? (USERS[it.assignedById] || ('#' + it.assignedById)) : null,
      url: itemUrl(it.id),
      isOurs: /^PLS-DOP/i.test(String(it.xmlId || '')) || !!localByItem[it.id],
      localId: localByItem[it.id] || null,
    })),
  };
}

// Перевод заявки на шаг процесса → пишет стадию в 1066. С проверкой условий:
// на нужные шаги нельзя перейти, пока не приложены документы / не согласовано.
async function moveStage(localId, stageKey) {
  const step = FLOW.find(s => s.key === stageKey);
  if (!step) throw new Error('Неизвестный шаг процесса');
  const itemId = await itemIdOf(localId);
  const reqmt = REQUIREMENTS[stageKey];
  if (reqmt) {
    const [{ result }, docFields] = await Promise.all([
      b24('crm.item.get', { entityTypeId: ENTITY, id: itemId }), resolveDocFields(),
    ]);
    const item = (result && result.item) || {};
    if (reqmt.kind === 'file' && !fileNonEmpty(item[docFields[reqmt.slot]])) {
      const e = new Error(`Нельзя перейти на «${step.label}»: не приложен ${reqmt.label}.`); e.userFacing = true; throw e;
    }
    if (reqmt.kind === 'files' && !reqmt.slots.every(sl => fileNonEmpty(item[docFields[sl]]))) {
      const e = new Error(`Нельзя перейти на «${step.label}»: нужны ${reqmt.label}.`); e.userFacing = true; throw e;
    }
    if (reqmt.kind === 'approval') {
      const ok = String(item[F.preApprove]) === APPROVE_YES && !!item[F.preApprover];
      if (!ok) { const e = new Error(`Нельзя перейти на «${step.label}»: нужен ${reqmt.label}.`); e.userFacing = true; throw e; }
    }
  }
  await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { stageId: step.bitrix } });
  await pool.query('UPDATE ticketsmodule_procurement SET stage_id=$1, updated_at=NOW() WHERE id=$2', [step.bitrix, localId]);
  // «Товар принят» — уведомляем согласующего и главбуха (закупка завершена).
  if (stageKey === 'received') {
    try {
      const ctx = await getRequestContext(localId);
      const { notifyPerson, emailHtml } = require('./procurement-notify');
      const t = ctx.title || ('#' + ctx.itemId);
      const targets = [...new Set([ctx.approverBid, ctx.accountantBid || chiefAccountantId()].filter(Boolean).map(String))];
      for (const uid of targets) {
        const tg = `📦 <b>Товар принят</b>\n📋 ${esc(t)}\nЗакупка завершена — товар получен.\n<a href="${dashUrl()}">Открыть</a>`;
        const html = emailHtml({ title: 'Товар принят', color: '#0e7c3f', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(ctx.dealId ? [['Сделка', '#' + ctx.dealId]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
        await notifyPerson(uid, { reason: 'Товар принят', tgText: tg, subject: 'Товар принят #' + ctx.itemId, html, itemId: ctx.itemId });
      }
    } catch (e) { /* уведомление best-effort */ }
  }
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
  const [stageDates, docFields] = await Promise.all([stageDatesFor(itemId), resolveDocFields()]);
  return {
    stageId: item.stageId,
    stageDates,
    docs: { invoice: fileInfo(docFields.invoice, 'invoice'), pay: fileInfo(docFields.pay, 'pay'), contract: fileInfo(docFields.contract, 'contract'), warranty: fileInfo(docFields.warranty, 'warranty') },
    dopy,
    approval: {
      status: item[F.preApprove] != null ? String(item[F.preApprove]) : null,
      approver: item[F.preApprover] || pl.apApprover || null,
      comment: item[F.preApproveComment] || '',
      approved: String(item[F.preApprove]) === APPROVE_YES,
      requested: !!pl.apRequested,
      decided: !!pl.apDecided,
      decidedAt: pl.apDecidedAt || null,
    },
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
  const fields = {};
  if (status) fields[F.preApprove] = status;
  if (approverId) fields[F.preApprover] = approverId;
  if (comment != null) fields[F.preApproveComment] = comment;
  await b24('crm.item.update', { entityTypeId: ENTITY, id: ctx.itemId, fields });
  // Отметить, что решение принято (снимает статус «На согласовании»).
  try {
    const { rows } = await pool.query('SELECT payload FROM ticketsmodule_procurement WHERE id=$1', [localId]);
    const pl = (rows[0] && rows[0].payload) || {};
    pl.apDecided = true; pl.apRequested = false; pl.apDecidedAt = new Date().toISOString();
    if (approverId) pl.apApprover = String(approverId);
    await pool.query('UPDATE ticketsmodule_procurement SET payload=$1, updated_at=NOW() WHERE id=$2', [pl, localId]);
  } catch (e) { /* флаг не критичен */ }

  const { notifyPerson, emailHtml } = require('./procurement-notify');
  const approved = String(status) === APPROVE_YES;
  const t = ctx.title || ('#' + ctx.itemId);
  // 1) уведомить создателя о решении
  if (ctx.creatorBid) {
    const verdict = approved ? 'согласована' : 'отклонена';
    const tg = `${approved ? '✅' : '⛔'} <b>Закупка ${verdict}</b>\n📋 ${esc(t)}${comment ? `\n💬 ${esc(comment)}` : ''}\n<a href="${dashUrl()}">Открыть</a>`;
    const html = emailHtml({ title: `Закупка ${verdict}`, color: approved ? '#0e7c3f' : '#b91c1c', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(comment ? [['Комментарий', comment]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
    await notifyPerson(ctx.creatorBid, { reason: 'Решение по согласованию', tgText: tg, subject: `Закупка ${verdict} #${ctx.itemId}`, html, itemId: ctx.itemId });
  }
  // 2) если согласовано — передать бухгалтеру на оплату (назначенному или главбуху)
  if (approved) {
    const chief = ctx.accountantBid || chiefAccountantId();
    if (chief) {
      const tg = `💰 <b>Требуется оплата закупки</b>\n📋 ${esc(t)}\nЗакупка согласована. Приложите «Подтверждение оплаты».\n<a href="${dashUrl()}">Открыть в дашборде</a>${ctx.itemUrl ? ` · <a href="${ctx.itemUrl}">в Битриксе</a>` : ''}`;
      const html = emailHtml({ title: 'Требуется оплата закупки', color: '#0f766e', lines: [['Заявка', '#' + ctx.itemId + ' — ' + (ctx.title || '')], ...(ctx.dealId ? [['Сделка', '#' + ctx.dealId]] : [])], itemUrl: ctx.itemUrl, dashUrl: dashUrl() });
      await notifyPerson(chief, { reason: 'Запрос оплаты', tgText: tg, subject: 'Требуется оплата закупки #' + ctx.itemId, html, itemId: ctx.itemId });
    }
  }
  return { ok: true, approved };
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
  // «Условия оплаты поставщикам (УС)» — всегда «100% оплата» при создании с дашборда.
  // Код поля и ID значения резолвятся динамически по названию (meta.oplataDefault);
  // если не нашлось — резерв на исторический код/значение.
  if (meta.oplataDefault && meta.oplataDefault.code) {
    fields[meta.oplataDefault.code] = meta.oplataDefault.valueId;
  } else {
    fields[F.oplataPostavshikam] = payload.oplataPostavshikam || '83';
  }
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

module.exports = { ENTITY, CATEGORY, TAG_PREFIX, F, DOCS, FLOW, getMeta, searchDeals, searchCompanies, resolveBin, listRequests, listByDeal, createRequest, updateRequest, deleteRequest, moveStage, getItemDetail, uploadDoc, setApproval, requestApproval, setAccountant, autoCreateFromService, itemUrl, dealUrl };

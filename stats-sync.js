// Keeps ticketsmodule_stat_deals in sync with Bitrix, so the Статистика
// dashboard queries our own DB instead of scanning all of Bitrix live on
// every page load. Three ways this stays fresh:
//   1. syncOneDeal() — called from the webhook on ONCRMDEALADD/ONCRMDEALUPDATE
//   2. fullSync() — one-time backfill (run manually once) or periodic
//      reconciliation (catches anything a missed webhook would leave stale)
const { b24 } = require('./bitrix');
const { pool } = require('./auth');

const REAL_CONTRACT_DATE_FIELD = 'UF_CRM_1753708701368';
const INSTRUMENT_FIELD = 'UF_CRM_NAME_PRIOBOR';
const DEPARTMENT_FIELD = 'UF_CRM_1758005356984'; // "Отдел" — confirmed via correlation across 93 deals (find-department-field.js)
// Производитель — поле-СПИСОК (enumeration), значение = ID элемента, имя бренда
// достаётся из определения поля. ПОДТВЕРЖДЕНО probe-manufacturer.js (резолв 20/20).
// Раньше грешили на UF_CRM_1731862648 — а это оказался РЕГИОН (инфоблок 17).
const MANUF_FIELD = 'UF_CRM_1733300779';
// Модель прибора — тоже поле-СПИСОК (enumeration), 331 значение, чистые имена
// моделей (в отличие от текстового UF_CRM_NAME_PRIOBOR, где встречается склейка-мусор).
// Подтверждено probe-manufacturer.js. Читаем enum как основной источник, текст — фолбэк.
const MODEL_FIELD = 'UF_CRM_1733300721';
const CATEGORY_IDS = ['0', '1', '2', '3'];

const SELECT_FIELDS = [
  'ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'TYPE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
  'COMPANY_ID', 'ASSIGNED_BY_ID', REAL_CONTRACT_DATE_FIELD, INSTRUMENT_FIELD, DEPARTMENT_FIELD, MANUF_FIELD, MODEL_FIELD,
];

// Резолв значения поля-списка (ID→имя); поддерживает и множественный выбор.
function resolveEnum(raw, map) {
  if (raw == null || raw === '') return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const names = arr.map(v => map[String(v)]).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

// Вшитый резерв ID→бренд (на случай, если userfield.list недоступен). Основной
// источник — динамический fetch ниже, чтобы новые бренды подхватывались сами.
const MANUF_FALLBACK = {
  '2860': 'Agilent Technologies', '2861': 'Metrohm', '2862': 'Malvern Panalytical', '2863': 'LECO', '2864': 'Wasson',
  '2865': 'LNI', '2866': 'Peak Scientific', '2867': 'Metrohm Autolab', '2868': 'Metrohm DropSens', '2869': 'Agilent Cell Analysis',
  '2870': 'Agilent Vacuum pump', '8212': 'PowTeq', '2871': 'ELGA LabWater', '8240': 'Struers', '5796': 'Waters', '2872': 'Другое',
  '8360': 'Sciaps', '8361': 'Belaquilon', '8362': 'Snol', '8363': 'Labtech', '8364': 'Biobase', '8365': 'Environmental Express',
  '8366': 'Mettler Toledo', '8367': 'Athena Instruments Pvt Ltd', '8368': 'Everfuge', '8369': 'Glass Expansion', '8370': 'Sciencix',
  '8371': 'LGC Standards', '8372': 'KUKA', '8443': 'OLYMPUS', '8815': 'Sartorius',
};

// В БАЗУ пишем СЫРОЙ бренд как есть (напр. «Agilent Cell Analysis»). Группировку
// в родительский бренд (Agilent) и раскрытие под-брендов делаем на отображении
// (stats-calc.js) — чтобы деталь не терялась и её можно было раскрыть.

// Карта ID→бренд из определения поля (кэш 6ч, новые бренды подхватятся сами).
let manufMapCache = null, manufMapAt = 0;
async function getManufacturerMap() {
  if (manufMapCache && Date.now() - manufMapAt < 6 * 3600 * 1000) return manufMapCache;
  try {
    const { result } = await b24('crm.deal.userfield.list', { filter: { FIELD_NAME: MANUF_FIELD } });
    const f = (result || [])[0];
    const map = {};
    (f?.LIST || []).forEach(it => { map[String(it.ID)] = it.VALUE; });
    if (Object.keys(map).length) { manufMapCache = map; manufMapAt = Date.now(); return map; }
  } catch (e) { console.error('getManufacturerMap error:', e.message); }
  manufMapCache = MANUF_FALLBACK; manufMapAt = Date.now();
  return MANUF_FALLBACK;
}

// Карта ID→модель прибора (331 значение) из определения поля, кэш 6ч.
let modelMapCache = null, modelMapAt = 0;
async function getModelMap() {
  if (modelMapCache && Date.now() - modelMapAt < 6 * 3600 * 1000) return modelMapCache;
  try {
    const { result } = await b24('crm.deal.userfield.list', { filter: { FIELD_NAME: MODEL_FIELD } });
    const f = (result || [])[0];
    const map = {};
    (f?.LIST || []).forEach(it => { map[String(it.ID)] = it.VALUE; });
    modelMapCache = map; modelMapAt = Date.now();
    return map;
  } catch (e) { console.error('getModelMap error:', e.message); return modelMapCache || {}; }
}

const companyIndustryCache = new Map();
async function getCompanyIndustry(companyId) {
  if (!companyId) return '';
  if (companyIndustryCache.has(companyId)) return companyIndustryCache.get(companyId);
  try {
    const { result } = await b24('crm.company.get', { id: companyId });
    const industry = result?.INDUSTRY || '';
    companyIndustryCache.set(companyId, industry);
    return industry;
  } catch (e) {
    companyIndustryCache.set(companyId, '');
    return '';
  }
}

async function getManufacturer(instrumentName) {
  if (!instrumentName) return null;
  const { rows } = await pool.query(
    'SELECT manufacturer FROM ticketsmodule_stat_instrument_manufacturer WHERE instrument_name=$1',
    [instrumentName]
  );
  return rows[0]?.manufacturer || null;
}

async function upsertDeal(d) {
  // Модель прибора: основной источник — поле-список (чистые имена), фолбэк —
  // старое текстовое поле (шире покрытие старых сделок, но бывает склейка-мусор).
  const modelMap = await getModelMap();
  const instrumentName = resolveEnum(d[MODEL_FIELD], modelMap) || d[INSTRUMENT_FIELD] || null;
  // Производитель — напрямую из поля-списка (ID→бренд). Если поле пустое —
  // фолбэк на старую карту «прибор→производитель» ради покрытия старых сделок.
  const manufMap = await getManufacturerMap();
  const rawManuf = d[MANUF_FIELD] ? (manufMap[String(d[MANUF_FIELD])] || null) : null;
  const manufacturer = rawManuf || (await getManufacturer(instrumentName)); // сырой бренд; группировка — на отображении
  const industry = await getCompanyIndustry(d.COMPANY_ID);
  const contractDate = d[REAL_CONTRACT_DATE_FIELD] ? d[REAL_CONTRACT_DATE_FIELD].slice(0, 10) : null;

  await pool.query(
    `INSERT INTO ticketsmodule_stat_deals
      (deal_id, category_id, stage_id, deal_type_id, opportunity, currency_id, company_id, assigned_by_id,
       contract_date, instrument_name, department_id, manufacturer, industry, deal_title, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
     ON CONFLICT (deal_id) DO UPDATE SET
       category_id=$2, stage_id=$3, deal_type_id=$4, opportunity=$5, currency_id=$6, company_id=$7, assigned_by_id=$8,
       contract_date=$9, instrument_name=$10, department_id=$11, manufacturer=$12, industry=$13, deal_title=$14, synced_at=NOW()`,
    [d.ID, parseInt(d.CATEGORY_ID, 10), d.STAGE_ID, d.TYPE_ID || null, parseFloat(d.OPPORTUNITY) || 0, d.CURRENCY_ID || 'KZT',
     d.COMPANY_ID || null, d.ASSIGNED_BY_ID ? parseInt(d.ASSIGNED_BY_ID, 10) : null,
     contractDate, instrumentName, d[DEPARTMENT_FIELD] || null, manufacturer, industry, d.TITLE || null]
  );
}

// Called from the webhook — syncs exactly one deal, fresh from Bitrix.
async function syncOneDeal(dealId) {
  const { result } = await b24('crm.deal.get', { id: dealId });
  if (!result) return;
  await upsertDeal(result);
}

async function paginatedDealList(filter) {
  let items = [];
  let start = 0;
  while (true) {
    const { result, next } = await b24('crm.deal.list', { filter, select: SELECT_FIELDS, start });
    items = items.concat(result || []);
    if (next === undefined || next === null) break;
    start = next;
  }
  return items;
}

// Full backfill/reconciliation — pulls every deal (any stage) across all 4
// pipelines and upserts. Safe to re-run any time.
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Защита от одновременного запуска двух полных сверок В ОДНОМ ПРОЦЕССЕ (ночная +
// ручной /resync). Второй вызов просто пропускается, а не удваивает нагрузку на
// Битрикс. (Ручной CLI `node sync-stats-full.js` — отдельный процесс, флаг на него
// не распространяется, но это осознанное действие, а не наложение по расписанию.)
let _fullSyncRunning = false;
async function fullSync() {
  if (_fullSyncRunning) { console.log('stats fullSync уже идёт — пропускаю повторный запуск'); return 0; }
  _fullSyncRunning = true;
  let total = 0, errors = 0;
  const startedAt = Date.now();
  try {
    for (const categoryId of CATEGORY_IDS) {
      const deals = await paginatedDealList({ CATEGORY_ID: categoryId });
      console.log(`Категория ${categoryId}: найдено ${deals.length} сделок`);

      for (const d of deals) {
        try {
          await upsertDeal(d);
          total++;
        } catch (e) {
          errors++;
          console.error(`  ⚠️  Ошибка на сделке #${d.ID}: ${e.message} (продолжаю дальше)`);
        }
        if (total % 50 === 0 && total > 0) {
          const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
          console.log(`  ...обработано ${total} сделок (${elapsedMin} мин, ошибок: ${errors})`);
        }
        await sleep(120); // stay under Bitrix's rate limit — long sync otherwise trips it partway through
      }
    }
  } finally {
    _fullSyncRunning = false;
  }

  const totalMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`✅ Синхронизировано: ${total} сделок за ${totalMin} мин. Ошибок: ${errors}.`);
  return total;
}

module.exports = { syncOneDeal, fullSync, upsertDeal };

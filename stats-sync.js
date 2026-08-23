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
// «План продаж»: планируемый срок покупки (date) и «Наиболее вероятная сделка» (boolean).
const PLANNED_PURCHASE_FIELD = 'UF_CRM_1731862888595';
const LIKELY_DEAL_FIELD = 'UF_CRM_1752737840347';
// «КП · Сервис»: дата установки/начала гарантии и окончание гарантии.
const INSTALL_DATE_FIELD = 'UF_CRM_GUARATN_START';
const WARRANTY_END_FIELD = 'UF_CRM_GUARANT_END';
const CATEGORY_IDS = ['0', '1', '2', '3'];

const SELECT_FIELDS = [
  'ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'TYPE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE',
  'COMPANY_ID', 'ASSIGNED_BY_ID', REAL_CONTRACT_DATE_FIELD, INSTRUMENT_FIELD, DEPARTMENT_FIELD, MANUF_FIELD, MODEL_FIELD,
  PLANNED_PURCHASE_FIELD, LIKELY_DEAL_FIELD, INSTALL_DATE_FIELD, WARRANTY_END_FIELD,
];

// Bitrix boolean-поля приходят как '1'/'0', 'Y'/'N', true/false — приводим к bool.
function toBool(v) { return v === true || v === 1 || v === '1' || v === 'Y' || v === 'yes' || v === 'true'; }

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

const companyInfoCache = new Map();
async function getCompanyInfo(companyId) {
  if (!companyId) return { industry: '', name: '' };
  if (companyInfoCache.has(companyId)) return companyInfoCache.get(companyId);
  let info = { industry: '', name: '' };
  try {
    const { result } = await b24('crm.company.get', { id: companyId });
    info = { industry: result?.INDUSTRY || '', name: result?.TITLE || '' };
  } catch (e) { /* best-effort */ }
  companyInfoCache.set(companyId, info);
  return info;
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
  const company = await getCompanyInfo(d.COMPANY_ID);
  const contractDate = d[REAL_CONTRACT_DATE_FIELD] ? d[REAL_CONTRACT_DATE_FIELD].slice(0, 10) : null;
  const dateCreate = d.DATE_CREATE ? d.DATE_CREATE.slice(0, 10) : null;
  const plannedPurchase = d[PLANNED_PURCHASE_FIELD] ? String(d[PLANNED_PURCHASE_FIELD]).slice(0, 10) : null;
  const likelyDeal = toBool(d[LIKELY_DEAL_FIELD]);
  const installDate = d[INSTALL_DATE_FIELD] ? String(d[INSTALL_DATE_FIELD]).slice(0, 10) : null;
  const warrantyEnd = d[WARRANTY_END_FIELD] ? String(d[WARRANTY_END_FIELD]).slice(0, 10) : null;

  await pool.query(
    `INSERT INTO ticketsmodule_stat_deals
      (deal_id, category_id, stage_id, deal_type_id, opportunity, currency_id, company_id, assigned_by_id,
       contract_date, instrument_name, department_id, manufacturer, industry, deal_title, date_create, company_name,
       planned_purchase_date, likely_deal, install_date, warranty_end, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
     ON CONFLICT (deal_id) DO UPDATE SET
       category_id=$2, stage_id=$3, deal_type_id=$4, opportunity=$5, currency_id=$6, company_id=$7, assigned_by_id=$8,
       contract_date=$9, instrument_name=$10, department_id=$11, manufacturer=$12, industry=$13, deal_title=$14,
       date_create=$15, company_name=$16, planned_purchase_date=$17, likely_deal=$18, install_date=$19, warranty_end=$20, synced_at=NOW()`,
    [d.ID, parseInt(d.CATEGORY_ID, 10), d.STAGE_ID, d.TYPE_ID || null, parseFloat(d.OPPORTUNITY) || 0, d.CURRENCY_ID || 'KZT',
     d.COMPANY_ID || null, d.ASSIGNED_BY_ID ? parseInt(d.ASSIGNED_BY_ID, 10) : null,
     contractDate, instrumentName, d[DEPARTMENT_FIELD] || null, manufacturer, company.industry, d.TITLE || null,
     dateCreate, company.name || null, plannedPurchase, likelyDeal, installDate, warrantyEnd]
  );
}

// Called from the webhook — syncs exactly one deal, fresh from Bitrix.
async function syncOneDeal(dealId) {
  const { result } = await b24('crm.deal.get', { id: dealId });
  if (!result) return;
  await upsertDeal(result);
}

// Удаление сделки из зеркала (вызывается из вебхука ONCRMDEALDELETE и реконсиляции).
async function deleteDeal(dealId) {
  await pool.query('DELETE FROM ticketsmodule_stat_deals WHERE deal_id=$1', [dealId]);
  await pool.query('DELETE FROM ticketsmodule_stage_history WHERE deal_id=$1', [dealId]).catch(() => {});
}

// Реконсиляция удалений: тянет из Битрикса ВСЕ актуальные ID сделок (только поле
// ID — быстро) и удаляет из зеркала строки, которых в Битриксе больше нет.
// Безопасность: если сбор ID оборвался ошибкой или пуст — НИЧЕГО не удаляем
// (иначе временный сбой Битрикса выкосил бы всё зеркало).
async function reconcileDeletions() {
  const ids = new Set();
  for (const categoryId of CATEGORY_IDS) {
    let start = 0;
    try {
      while (true) {
        const { result, next } = await b24('crm.deal.list', { filter: { CATEGORY_ID: categoryId }, select: ['ID'], start });
        (result || []).forEach(d => ids.add(Number(d.ID)));
        if (next === undefined || next === null) break;
        start = next;
        await sleep(40);
      }
    } catch (e) {
      console.error('reconcileDeletions: сбор ID прерван — отмена во избежание ложных удалений:', e.message);
      return { deleted: 0, aborted: true };
    }
  }
  if (!ids.size) return { deleted: 0, aborted: true };
  const { rows } = await pool.query('SELECT deal_id FROM ticketsmodule_stat_deals');
  const orphans = rows.map(r => Number(r.deal_id)).filter(id => !ids.has(id));
  for (const id of orphans) await deleteDeal(id);
  if (orphans.length) console.log(`🧹 Реконсиляция: удалено ${orphans.length} сделок, которых нет в Битриксе: ${orphans.slice(0, 20).join(', ')}${orphans.length > 20 ? '…' : ''}`);
  return { deleted: orphans.length, orphans };
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

  // После полной сверки — убрать из зеркала сделки, удалённые в Битриксе.
  try { await reconcileDeletions(); } catch (e) { console.error('reconcileDeletions в fullSync:', e.message); }

  const totalMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`✅ Синхронизировано: ${total} сделок за ${totalMin} мин. Ошибок: ${errors}.`);
  return total;
}

// Инкрементальная синхронизация: тянет из Битрикса только сделки, ИЗМЕНЁННЫЕ
// после `sinceMs` (по DATE_MODIFY), и апсертит их в зеркало. Идёт быстро, т.к.
// за день меняется мало сделок. Используется кнопкой «Обновить» в Контрактах.
// sinceMs — момент в UTC (мс). Overlap-буфер вычитается вызывающим кодом.
const _toBitrixDT = ms => new Date(ms).toISOString().slice(0, 19) + '+00:00';
let _incRunning = false;
async function incrementalSync(sinceMs) {
  if (_incRunning) { console.log('incrementalSync уже идёт — пропускаю'); return { updated: 0, skipped: true }; }
  _incRunning = true;
  const since = _toBitrixDT(sinceMs);
  let updated = 0;
  try {
    for (const categoryId of CATEGORY_IDS) {
      let start = 0;
      while (true) {
        const { result, next } = await b24('crm.deal.list', {
          filter: { CATEGORY_ID: categoryId, '>=DATE_MODIFY': since },
          select: SELECT_FIELDS, order: { DATE_MODIFY: 'ASC' }, start,
        });
        for (const d of (result || [])) {
          try { await upsertDeal(d); updated++; }
          catch (e) { console.error(`  ⚠️ inc upsert #${d.ID}: ${e.message}`); }
          await sleep(60);
        }
        if (next === undefined || next === null) break;
        start = next;
      }
    }
    console.log(`✅ Инкрементальная синхронизация: обновлено ${updated} сделок (с ${since})`);
  } finally {
    _incRunning = false;
  }
  return { updated, since };
}

module.exports = { syncOneDeal, deleteDeal, reconcileDeletions, fullSync, upsertDeal, incrementalSync };

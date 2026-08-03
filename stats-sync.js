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
const DEPARTMENT_FIELD = 'UF_CRM_DEPARTMENT';
const CATEGORY_IDS = ['0', '1', '2', '3'];

const SELECT_FIELDS = [
  'ID', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
  'COMPANY_ID', 'ASSIGNED_BY_ID', REAL_CONTRACT_DATE_FIELD, INSTRUMENT_FIELD, DEPARTMENT_FIELD,
];

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
  const instrumentName = d[INSTRUMENT_FIELD] || null;
  const manufacturer = await getManufacturer(instrumentName);
  const industry = await getCompanyIndustry(d.COMPANY_ID);
  const contractDate = d[REAL_CONTRACT_DATE_FIELD] ? d[REAL_CONTRACT_DATE_FIELD].slice(0, 10) : null;

  await pool.query(
    `INSERT INTO ticketsmodule_stat_deals
      (deal_id, category_id, stage_id, opportunity, currency_id, company_id, assigned_by_id,
       contract_date, instrument_name, department_id, manufacturer, industry, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
     ON CONFLICT (deal_id) DO UPDATE SET
       category_id=$2, stage_id=$3, opportunity=$4, currency_id=$5, company_id=$6, assigned_by_id=$7,
       contract_date=$8, instrument_name=$9, department_id=$10, manufacturer=$11, industry=$12, synced_at=NOW()`,
    [d.ID, parseInt(d.CATEGORY_ID, 10), d.STAGE_ID, parseFloat(d.OPPORTUNITY) || 0, d.CURRENCY_ID || 'KZT',
     d.COMPANY_ID || null, d.ASSIGNED_BY_ID ? parseInt(d.ASSIGNED_BY_ID, 10) : null,
     contractDate, instrumentName, d[DEPARTMENT_FIELD] || null, manufacturer, industry]
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
async function fullSync() {
  let total = 0;
  for (const categoryId of CATEGORY_IDS) {
    const deals = await paginatedDealList({ CATEGORY_ID: categoryId });
    console.log(`Категория ${categoryId}: найдено ${deals.length} сделок`);
    for (const d of deals) {
      await upsertDeal(d);
      total++;
    }
  }
  console.log(`✅ Синхронизировано всего: ${total} сделок`);
  return total;
}

module.exports = { syncOneDeal, fullSync, upsertDeal };

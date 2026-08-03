const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');

const REAL_CONTRACT_DATE_FIELD = 'UF_CRM_1753708701368'; // Дата договора, confirmed via find-deal-fields.js
const INSTRUMENT_FIELD = 'UF_CRM_NAME_PRIOBOR';
const DEPARTMENT_FIELD = 'UF_CRM_DEPARTMENT';

const PIPELINES = {
  0: { name: 'Продажа инструментов', shortName: 'Inst', wonStage: 'WON' },
  1: { name: 'Продажа расходных материалов', shortName: 'Spares', wonStage: 'C1:WON' },
  2: { name: 'Продажа услуг тренинг-центра', shortName: 'Training', wonStage: 'C2:WON' },
  3: { name: 'Продажа сервиса', shortName: 'Service', wonStage: 'C3:WON' },
};

const SELECT_FIELDS = [
  'ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
  'COMPANY_ID', 'ASSIGNED_BY_ID', REAL_CONTRACT_DATE_FIELD, INSTRUMENT_FIELD, DEPARTMENT_FIELD,
];

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

// Pulls every WON deal across all 4 pipelines whose Дата договора falls in
// [startDate, endDate], with sums converted to KZT at today's rate.
async function getWonDealsInRange(startDate, endDate) {
  const rate = await getTodayRate();
  const deals = [];

  for (const [categoryId, cfg] of Object.entries(PIPELINES)) {
    const filter = {
      CATEGORY_ID: categoryId,
      STAGE_ID: cfg.wonStage,
      [`>=${REAL_CONTRACT_DATE_FIELD}`]: startDate,
      [`<=${REAL_CONTRACT_DATE_FIELD}`]: endDate,
    };
    const raw = await paginatedDealList(filter);
    for (const d of raw) {
      const sum = parseFloat(d.OPPORTUNITY) || 0;
      const currency = d.CURRENCY_ID || 'KZT';
      const sumKzt = currency === 'USD' ? sum * rate : sum;
      const instrumentName = d[INSTRUMENT_FIELD] || '';
      const manufacturer = await getManufacturer(instrumentName);
      const industry = await getCompanyIndustry(d.COMPANY_ID);

      deals.push({
        id: d.ID,
        pipelineId: Number(categoryId),
        pipelineName: cfg.name,
        saleType: cfg.shortName,
        sumKzt,
        managerId: d.ASSIGNED_BY_ID ? parseInt(d.ASSIGNED_BY_ID, 10) : null,
        managerName: d.ASSIGNED_BY_ID ? (USERS[d.ASSIGNED_BY_ID] || `#${d.ASSIGNED_BY_ID}`) : '—',
        departmentId: d[DEPARTMENT_FIELD] || null,
        companyId: d.COMPANY_ID || null,
        industry,
        instrumentName,
        manufacturer: manufacturer || 'Не определено',
        contractDate: d[REAL_CONTRACT_DATE_FIELD],
        year: d[REAL_CONTRACT_DATE_FIELD] ? new Date(d[REAL_CONTRACT_DATE_FIELD]).getFullYear() : null,
      });
    }
  }
  return deals;
}

// Manufacturer x sale-type summary table, matching the reference screenshot
// (rows: Inst/Spares/Service sums+percentages, columns: Common + each manufacturer)
function summarizeByManufacturerAndType(deals) {
  const manufacturers = [...new Set(deals.map(d => d.manufacturer))].filter(m => m !== 'Не определено').sort();
  const types = ['Inst', 'Spares', 'Training', 'Service'];

  const table = {};
  for (const type of types) {
    table[type] = { Common: 0 };
    manufacturers.forEach(m => { table[type][m] = 0; });
  }
  for (const d of deals) {
    if (!table[d.saleType]) continue;
    table[d.saleType].Common += d.sumKzt;
    if (d.manufacturer !== 'Не определено') table[d.saleType][d.manufacturer] += d.sumKzt;
  }
  return { manufacturers, types, table };
}

function summarizeByManager(deals) {
  const byManager = {};
  for (const d of deals) {
    const key = d.managerId || 'unknown';
    if (!byManager[key]) byManager[key] = { managerId: d.managerId, managerName: d.managerName, totalKzt: 0, dealCount: 0, instruments: {} };
    byManager[key].totalKzt += d.sumKzt;
    byManager[key].dealCount += 1;
    if (d.instrumentName) {
      byManager[key].instruments[d.instrumentName] = (byManager[key].instruments[d.instrumentName] || 0) + 1;
    }
  }
  return Object.values(byManager).map(m => ({
    ...m,
    avgCheckKzt: m.dealCount ? m.totalKzt / m.dealCount : 0,
  })).sort((a, b) => b.totalKzt - a.totalKzt);
}

function summarizeByInstrument(deals) {
  const byInstrument = {};
  for (const d of deals) {
    if (!d.instrumentName) continue;
    const key = d.instrumentName;
    if (!byInstrument[key]) byInstrument[key] = { instrumentName: key, manufacturer: d.manufacturer, totalKzt: 0, count: 0 };
    byInstrument[key].totalKzt += d.sumKzt;
    byInstrument[key].count += 1;
  }
  return Object.values(byInstrument).map(i => ({
    ...i,
    avgCheckKzt: i.count ? i.totalKzt / i.count : 0,
  })).sort((a, b) => b.totalKzt - a.totalKzt);
}

module.exports = {
  getWonDealsInRange, summarizeByManufacturerAndType, summarizeByManager, summarizeByInstrument,
  PIPELINES, REAL_CONTRACT_DATE_FIELD, INSTRUMENT_FIELD, DEPARTMENT_FIELD,
};

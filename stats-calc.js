const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');

const PIPELINES = {
  0: { name: 'Продажа инструментов', shortName: 'Inst', completedStages: ['FINAL_INVOICE','1','UC_Q9J6VV','UC_9MBFR2','2','3','WON'] },
  1: { name: 'Продажа расходных материалов', shortName: 'Spares', completedStages: ['C1:FINAL_INVOICE','C1:1','C1:UC_3MVK90','C1:UC_3SCB5K','C1:2','C1:3','C1:WON'] },
  2: { name: 'Продажа услуг тренинг-центра', shortName: 'Training', completedStages: ['C2:FINAL_INVOICE','C2:1','C2:2','C2:WON'] },
  3: { name: 'Продажа сервиса', shortName: 'Service', completedStages: ['C3:FINAL_INVOICE','C3:UC_YYTFYG','C3:2','C3:WON'] },
};

// Тип сделки within category 0 (Продажа инструментов) — confirmed directly
// in Bitrix's own "Тип сделки" dropdown: only these 3 values exist for this
// pipeline. Split out separately per the user's request, since lumping
// General lab/Robots into "Instrument" overstated that category.
const DEAL_TYPE_LABELS = { SALE: 'Instrument', UC_TA384N: 'General lab', SERVICE: 'Robots' };

// Reads WON/completed deals for the given date range straight from our
// local cache (ticketsmodule_stat_deals) — kept in sync via webhooks +
// periodic reconciliation (see stats-sync.js) instead of scanning Bitrix
// live on every dashboard load.
async function getWonDealsInRange(startDate, endDate) {
  const rate = await getTodayRate();
  const allStages = Object.values(PIPELINES).flatMap(p => p.completedStages);

  const { rows } = await pool.query(
    `SELECT * FROM ticketsmodule_stat_deals
     WHERE stage_id = ANY($1) AND contract_date BETWEEN $2 AND $3`,
    [allStages, startDate, endDate]
  );

  return rows.map(d => {
    const cfg = PIPELINES[d.category_id] || { name: 'Неизвестно', shortName: '?' };
    const sum = parseFloat(d.opportunity) || 0;
    const sumKzt = d.currency_id === 'USD' ? sum * rate : sum;
    const saleType = d.category_id === 0
      ? (DEAL_TYPE_LABELS[d.deal_type_id] || d.deal_type_id || 'Instrument')
      : cfg.shortName;
    return {
      id: d.deal_id,
      pipelineId: d.category_id,
      pipelineName: cfg.name,
      saleType,
      sumKzt,
      managerId: d.assigned_by_id,
      managerName: d.assigned_by_id ? (USERS[d.assigned_by_id] || `#${d.assigned_by_id}`) : '—',
      departmentId: d.department_id,
      companyId: d.company_id,
      industry: d.industry || '',
      instrumentName: d.instrument_name || '',
      manufacturer: d.manufacturer || 'Не определено',
      contractDate: d.contract_date,
      year: d.contract_date ? new Date(d.contract_date).getFullYear() : null,
    };
  });
}

function summarizeByManufacturerAndType(deals) {
  const manufacturers = [...new Set(deals.map(d => d.manufacturer))].filter(m => m !== 'Не определено').sort();
  const typeOrder = ['Instrument', 'General lab', 'Robots', 'Spares', 'Training', 'Service'];
  const presentTypes = new Set(deals.map(d => d.saleType));
  const types = typeOrder.filter(t => presentTypes.has(t));
  // Any type not in our known order (shouldn't normally happen) still shows up, appended at the end
  [...presentTypes].forEach(t => { if (!types.includes(t)) types.push(t); });

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
    if (!byInstrument[key]) byInstrument[key] = { instrumentName: key, manufacturer: d.manufacturer, totalKzt: 0, count: 0, byDepartment: {} };
    byInstrument[key].totalKzt += d.sumKzt;
    byInstrument[key].count += 1;
    const deptKey = d.departmentId || 'Не указан';
    if (!byInstrument[key].byDepartment[deptKey]) byInstrument[key].byDepartment[deptKey] = { departmentId: deptKey, totalKzt: 0, count: 0 };
    byInstrument[key].byDepartment[deptKey].totalKzt += d.sumKzt;
    byInstrument[key].byDepartment[deptKey].count += 1;
  }
  return Object.values(byInstrument).map(i => ({
    ...i,
    avgCheckKzt: i.count ? i.totalKzt / i.count : 0,
    byDepartment: Object.values(i.byDepartment).sort((a, b) => b.totalKzt - a.totalKzt),
  })).sort((a, b) => b.totalKzt - a.totalKzt);
}

module.exports = {
  getWonDealsInRange, summarizeByManufacturerAndType, summarizeByManager, summarizeByInstrument,
  PIPELINES,
};

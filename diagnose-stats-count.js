// Run in Railway Console: node diagnose-stats-count.js 2025
// Shows, per pipeline: how many deals match category+completed-stage-range
// with NO date filter, vs how many remain once filtered by Дата договора —
// to see whether the date field itself is sparsely filled (a second cause
// of undercounting, separate from the stage-range bug).

const { b24 } = require('./bitrix');
const { PIPELINES } = require('./stats-calc');
const REAL_CONTRACT_DATE_FIELD = 'UF_CRM_1753708701368';

async function countDeals(filter) {
  let total = 0;
  let start = 0;
  while (true) {
    const { result, next, total: apiTotal } = await b24('crm.deal.list', { filter, select: ['ID'], start });
    total += (result || []).length;
    if (next === undefined || next === null) break;
    start = next;
  }
  return total;
}

async function main() {
  const year = process.argv[2] || String(new Date().getFullYear());
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  for (const [categoryId, cfg] of Object.entries(PIPELINES)) {
    const baseFilter = { CATEGORY_ID: categoryId, '@STAGE_ID': cfg.completedStages };
    const withDate = { ...baseFilter, [`>=${REAL_CONTRACT_DATE_FIELD}`]: startDate, [`<=${REAL_CONTRACT_DATE_FIELD}`]: endDate };

    const noDateCount = await countDeals(baseFilter);
    const withDateCount = await countDeals(withDate);

    console.log(`${cfg.name} (категория ${categoryId}):`);
    console.log(`  Всего завершённых сделок (за всё время, без фильтра по дате): ${noDateCount}`);
    console.log(`  Из них с "Дата договора" в ${year}: ${withDateCount}`);
    console.log(`  (разница — это сделки других лет ИЛИ сделки без заполненной даты договора; чтобы понять, сколько именно без даты, нужно смотреть отдельно)\n`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

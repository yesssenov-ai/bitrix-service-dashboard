// Run in Railway Console: node sample-manufacturer-ids.js
// Pulls EVERY deal across all 4 sales pipelines (no sampling — a rare
// manufacturer used only once could otherwise be missed), groups them by
// the raw Производитель ID (UF_CRM_1731862648), and shows a few example
// instrument names/titles per ID — so each ID can be matched to a real
// manufacturer name by recognizing the instruments (e.g. "MIRA P" ->
// Metrohm, confirmed earlier as ID 49).

const { b24 } = require('./bitrix');

const FIELD = 'UF_CRM_1731862648';
const CATEGORIES = ['0', '1', '2', '3'];

async function main() {
  const byId = {};
  let totalScanned = 0;

  for (const categoryId of CATEGORIES) {
    let start = 0;
    let categoryCount = 0;
    while (true) {
      const { result, next } = await b24('crm.deal.list', {
        filter: { CATEGORY_ID: categoryId },
        select: ['ID', 'TITLE', FIELD, 'UF_CRM_NAME_PRIOBOR'],
        start,
      });
      const deals = result || [];
      categoryCount += deals.length;
      for (const d of deals) {
        const id = d[FIELD];
        if (!id) continue;
        if (!byId[id]) byId[id] = [];
        if (byId[id].length < 5) {
          byId[id].push(`#${d.ID}: ${d.UF_CRM_NAME_PRIOBOR || d.TITLE}`);
        }
      }
      if (next === undefined || next === null) break; // no more pages
      start = next;
    }
    console.log(`Воронка ${categoryId}: просканировано ${categoryCount} сделок`);
    totalScanned += categoryCount;
  }

  console.log(`\nВсего сделок просканировано: ${totalScanned}`);
  console.log(`Найдено уникальных ID производителя: ${Object.keys(byId).length}\n`);
  Object.entries(byId)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([id, examples]) => {
      console.log(`--- ID ${id} (примеров: ${examples.length}${examples.length===5?'+':''}) ---`);
      examples.forEach(e => console.log(`   ${e}`));
      console.log();
    });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

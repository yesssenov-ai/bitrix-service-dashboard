// Run in Railway Console: node diagnose-unmapped-instruments.js 2026
// Shows which instrument names are contributing to "Не определено" in the
// manufacturer breakdown for a given year, with their total sum — so we
// know exactly what to add to instrument_manufacturer_map.json to close
// the gap between "Common" and the sum of individual manufacturer columns.
const { getWonDealsInRange } = require('./stats-calc');

async function main() {
  const year = process.argv[2] || String(new Date().getFullYear());
  const deals = await getWonDealsInRange(`${year}-01-01`, `${year}-12-31`);

  const unmapped = deals.filter(d => d.manufacturer === 'Не определено');
  const byInstrument = {};
  let totalUnmapped = 0;
  for (const d of unmapped) {
    const key = d.instrumentName || '(без названия прибора)';
    if (!byInstrument[key]) byInstrument[key] = { count: 0, sumKzt: 0 };
    byInstrument[key].count++;
    byInstrument[key].sumKzt += d.sumKzt;
    totalUnmapped += d.sumKzt;
  }

  console.log(`Год ${year}: всего сделок ${deals.length}, с неопределённым производителем: ${unmapped.length}`);
  console.log(`Сумма "Не определено": ${Math.round(totalUnmapped).toLocaleString('ru-RU')} ₸\n`);
  console.log('=== По названиям приборов (нет в справочнике) ===\n');
  Object.entries(byInstrument)
    .sort((a, b) => b[1].sumKzt - a[1].sumKzt)
    .forEach(([name, v]) => console.log(`  ${name.padEnd(40)} | ${v.count} сделок | ${Math.round(v.sumKzt).toLocaleString('ru-RU')} ₸`));

  console.log('\n=== Пустые "название прибора" — по строке (Отдел/тип продажи) ===\n');
  const noNameDeals = unmapped.filter(d => !d.instrumentName);
  const bySaleType = {};
  for (const d of noNameDeals) {
    if (!bySaleType[d.saleType]) bySaleType[d.saleType] = { count: 0, sumKzt: 0 };
    bySaleType[d.saleType].count++;
    bySaleType[d.saleType].sumKzt += d.sumKzt;
  }
  Object.entries(bySaleType)
    .sort((a, b) => b[1].sumKzt - a[1].sumKzt)
    .forEach(([type, v]) => console.log(`  ${type.padEnd(35)} | ${v.count} сделок | ${Math.round(v.sumKzt).toLocaleString('ru-RU')} ₸`));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

// Run in Railway Console: node find-manufacturer-field.js
// We assumed UF_CRM_1731862648 was "Производитель" based on just 2 early
// examples — the SAME mistake we almost made with "Отдел" before doing a
// proper systematic search. This does the correct thing this time: checks
// EVERY field on all 436 clean deals (deal_manufacturer_reference_clean.json)
// for 100% correlation with the known resolved manufacturer text, exactly
// like find-department-field.js did successfully for Отдел.

const fs = require('fs');
const { b24 } = require('./bitrix');

async function main() {
  const reference = JSON.parse(fs.readFileSync('./deal_manufacturer_reference_clean.json', 'utf-8'));
  const dealIds = Object.keys(reference).map(Number);
  console.log(`Сверяю ${dealIds.length} сделок по ВСЕМ полям сразу...\n`);

  // fieldCode -> rawValue -> Set of manufacturer labels seen with that raw value
  const correlation = {};

  for (let i = 0; i < dealIds.length; i += 50) {
    const batch = dealIds.slice(i, i + 50);
    const { result } = await b24('crm.deal.list', { filter: { '@ID': batch }, select: ['*', 'UF_*'] });
    for (const deal of (result || [])) {
      const label = reference[deal.ID];
      for (const [field, value] of Object.entries(deal)) {
        if (value === null || value === undefined || value === '' || value === false) continue;
        if (typeof value === 'object') continue; // skip file/array-of-objects fields
        const raw = Array.isArray(value) ? value.join(',') : String(value);
        if (!correlation[field]) correlation[field] = {};
        if (!correlation[field][raw]) correlation[field][raw] = new Set();
        correlation[field][raw].add(label);
      }
    }
    await new Promise(r => setTimeout(r, 150));
    if (i % 200 === 0) console.log(`  ...обработано ${Math.min(i + 50, dealIds.length)} из ${dealIds.length}`);
  }

  console.log('\n=== Поля с ИДЕАЛЬНОЙ корреляцией (каждое сырое значение -> ровно один производитель, БЕЗ исключений) ===\n');
  const scored = [];
  for (const [field, rawMap] of Object.entries(correlation)) {
    const rawValues = Object.keys(rawMap);
    if (rawValues.length < 5) continue; // need enough variety to be meaningful (31 known manufacturers exist)
    const allClean = rawValues.every(raw => rawMap[raw].size === 1);
    if (!allClean) continue;
    const distinctLabelsCovered = new Set();
    rawValues.forEach(raw => rawMap[raw].forEach(l => distinctLabelsCovered.add(l)));
    scored.push({ field, distinctValues: rawValues.length, labelsCovered: distinctLabelsCovered.size });
  }
  scored.sort((a, b) => b.labelsCovered - a.labelsCovered);

  if (!scored.length) {
    console.log('  Ничего не нашлось с идеальной корреляцией ни по одному полю.');
  }
  scored.slice(0, 5).forEach(s => {
    console.log(`  ${s.field} — различает ${s.labelsCovered} производителей, ${s.distinctValues} уникальных сырых значений`);
    const rawMap = correlation[s.field];
    Object.entries(rawMap).forEach(([raw, labels]) => console.log(`      ${raw} = ${[...labels][0]}`));
    console.log();
  });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

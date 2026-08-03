// Run in Railway Console: node find-department-field.js
// Instead of manually diffing two deals (which failed to isolate a clean
// candidate), this fetches raw fields for all 93 deals in
// deal_department_reference.json (dealId -> known "Отдел" label from a
// Bitrix export) and checks EVERY field code for how well it correlates:
// a field is a strong candidate if each distinct raw value maps to exactly
// one Отдел label (no contradictions) across all 93 deals.

const fs = require('fs');
const { b24 } = require('./bitrix');

async function main() {
  const reference = JSON.parse(fs.readFileSync('./deal_department_reference.json', 'utf-8'));
  const dealIds = Object.keys(reference).map(Number);
  console.log(`Сверяю ${dealIds.length} сделок...\n`);

  // fieldCode -> rawValue -> Set of Отдел labels seen with that raw value
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
  }

  // Score each field: how many distinct raw values map to exactly one label,
  // and how many distinct labels does this field distinguish overall
  console.log('=== Поля с лучшей корреляцией (каждое сырое значение -> ровно один Отдел) ===\n');
  const scored = [];
  for (const [field, rawMap] of Object.entries(correlation)) {
    const rawValues = Object.keys(rawMap);
    if (rawValues.length < 3) continue; // need some variety to be meaningful
    const cleanValues = rawValues.filter(raw => rawMap[raw].size === 1);
    const distinctLabelsCovered = new Set();
    cleanValues.forEach(raw => rawMap[raw].forEach(l => distinctLabelsCovered.add(l)));
    if (cleanValues.length === rawValues.length && distinctLabelsCovered.size >= 3) {
      scored.push({ field, distinctValues: rawValues.length, labelsCovered: distinctLabelsCovered.size });
    }
  }
  scored.sort((a, b) => b.labelsCovered - a.labelsCovered);
  scored.slice(0, 10).forEach(s => {
    console.log(`  ${s.field} — различает ${s.labelsCovered} значений Отдела, ${s.distinctValues} уникальных сырых значений`);
    const rawMap = correlation[s.field];
    Object.entries(rawMap).forEach(([raw, labels]) => console.log(`      ${raw} = ${[...labels][0]}`));
  });

  if (!scored.length) console.log('  Ничего не нашлось с чистой корреляцией — пришлю полный дамп для ручного разбора.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

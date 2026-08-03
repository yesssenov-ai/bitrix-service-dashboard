// Run in Railway Console: node verify-department-field.js
// Targeted check — we already know the field (UF_CRM_1758005356984), just
// need to confirm the raw values for the categories not yet in our map
// (Training, Материаловедение, Клеточный анализ, Complex, Service).
const fs = require('fs');
const { b24 } = require('./bitrix');

const FIELD = 'UF_CRM_1758005356984';

async function main() {
  const reference = JSON.parse(fs.readFileSync('./deal_department_reference2.json', 'utf-8'));
  const dealIds = Object.keys(reference).map(Number);

  const byLabel = {};
  for (let i = 0; i < dealIds.length; i += 50) {
    const batch = dealIds.slice(i, i + 50);
    const { result } = await b24('crm.deal.list', { filter: { '@ID': batch }, select: ['ID', FIELD] });
    for (const deal of (result || [])) {
      const label = reference[deal.ID];
      const raw = deal[FIELD];
      if (!byLabel[label]) byLabel[label] = new Set();
      byLabel[label].add(raw);
    }
  }

  console.log('=== Сырые значения по каждой категории ===\n');
  Object.entries(byLabel).forEach(([label, rawSet]) => {
    console.log(`  ${label}: ${[...rawSet].join(', ')}`);
  });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

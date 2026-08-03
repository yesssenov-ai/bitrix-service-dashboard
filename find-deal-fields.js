// Run in Railway Console:
//   node find-deal-fields.js "Inst-2026-148"     — search by title fragment
//   node find-deal-fields.js id 103846           — fetch one deal directly by ID
//   node find-deal-fields.js items UF_CRM_XXXXX  — list all possible values for one field

const { b24 } = require('./bitrix');

function printDeal(deal) {
  console.log(`${'='.repeat(20)} Сделка #${deal.ID}: ${deal.TITLE} ${'='.repeat(20)}`);
  Object.entries(deal).forEach(([code, value]) => {
    if (value === null || value === '' || value === undefined) return;
    if (Array.isArray(value) && !value.length) return;
    console.log(`  ${code.padEnd(28)} = ${JSON.stringify(value)}`);
  });
  console.log();
}

async function main() {
  const [, , mode, arg] = process.argv;

  if (mode === 'id') {
    const { result } = await b24('crm.deal.get', { id: arg });
    if (!result) { console.log('Сделка не найдена'); return; }
    printDeal(result);
    return;
  }

  if (mode === 'items') {
    const { result } = await b24('crm.deal.fields', {});
    const field = result?.[arg];
    if (!field) { console.log(`Поле ${arg} не найдено`); return; }
    console.log(`Поле ${arg} — type=${field.type}, isMultiple=${field.isMultiple}\n`);
    (field.items || []).forEach(i => console.log(`  ${JSON.stringify(i)}`));
    if (!field.items) console.log('(нет списка значений — не enum/iblock-поле, или значения не отдаются через API)');
    return;
  }

  // Default: search by title fragment (original behaviour)
  const needle = mode;
  if (!needle) { console.error('Usage:\n  node find-deal-fields.js "<title fragment>"\n  node find-deal-fields.js id <dealId>\n  node find-deal-fields.js items <fieldCode>'); process.exit(1); }

  const { result } = await b24('crm.deal.list', {
    filter: { '%TITLE': needle },
    select: ['*', 'UF_*'],
  });
  const deals = result || [];
  console.log(`Найдено сделок: ${deals.length}\n`);
  deals.forEach(printDeal);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

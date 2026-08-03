// Run in Railway Console: node find-deal-fields.js "Inst-2026-148"
// Searches deals by a title fragment and prints every field + value for each
// match — use this to find a field's real code by matching the VALUE you
// can see on screen in Bitrix (e.g. a contract date, an instrument name),
// since crm.deal.fields doesn't return human-readable titles for custom
// fields on this account.

const { b24 } = require('./bitrix');

async function main() {
  const needle = process.argv[2];
  if (!needle) { console.error('Usage: node find-deal-fields.js "<title fragment>"'); process.exit(1); }

  const { result } = await b24('crm.deal.list', {
    filter: { '%TITLE': needle },
    select: ['*', 'UF_*'],
  });

  const deals = result || [];
  console.log(`Найдено сделок: ${deals.length}\n`);

  for (const deal of deals) {
    console.log(`${'='.repeat(20)} Сделка #${deal.ID}: ${deal.TITLE} ${'='.repeat(20)}`);
    Object.entries(deal).forEach(([code, value]) => {
      if (value === null || value === '' || value === undefined) return;
      if (Array.isArray(value) && !value.length) return;
      console.log(`  ${code.padEnd(28)} = ${JSON.stringify(value)}`);
    });
    console.log();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

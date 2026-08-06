// Run in Railway Console: node find-ticket-email-field.js <ticketId>
// Finds the exact field code holding "E-mail (CRM форма)" on a service
// ticket (smart process, entityTypeId=1058) by dumping all fields for a
// ticket you know the client email for — look for the field whose value
// matches that email in the output.
const { b24 } = require('./bitrix');

async function main() {
  const ticketId = process.argv[2];
  if (!ticketId) { console.error('Usage: node find-ticket-email-field.js <ticketId>'); process.exit(1); }

  const { result } = await b24('crm.item.get', { entityTypeId: 1058, id: ticketId });
  const item = result?.item;
  if (!item) { console.error('Заявка не найдена'); process.exit(1); }

  console.log(`=== Все поля заявки #${ticketId} ===\n`);
  Object.entries(item).forEach(([field, value]) => {
    if (value === null || value === undefined || value === '' || value === false) return;
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const looksLikeEmail = /@/.test(str);
    console.log(`  ${field.padEnd(30)} = ${str}${looksLikeEmail ? '   ⭐ похоже на email' : ''}`);
  });
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

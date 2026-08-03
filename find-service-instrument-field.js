// Run in Railway Console: node find-service-instrument-field.js 104575
// "Название прибора" on Service-pipeline deals might not be free text like
// UF_CRM_NAME_PRIOBOR — it could be a numeric ID into the SAME instrument
// catalog used elsewhere (getPriborMap, ~325 entries). This finds that ID
// for the known instrument name, then scans every field on the given deal
// for a matching value.
const { b24 } = require('./bitrix');
const { getPriborMap } = require('./bitrix-lookups');

async function main() {
  const dealId = process.argv[2];
  const knownInstrumentName = process.argv[3] || 'ICP-MS 7850';
  if (!dealId) { console.error('Usage: node find-service-instrument-field.js <dealId> ["<instrument name from title>"]'); process.exit(1); }

  const priborMap = await getPriborMap();
  const matchingIds = Object.entries(priborMap).filter(([id, name]) => name === knownInstrumentName).map(([id]) => id);
  console.log(`ID(ов) прибора "${knownInstrumentName}" в справочнике: ${matchingIds.join(', ') || 'НЕ НАЙДЕНО'}\n`);

  const { result } = await b24('crm.deal.get', { id: dealId });
  if (!result) { console.log('Сделка не найдена'); return; }

  console.log(`=== Поля сделки #${dealId}, где встречается ID прибора ===\n`);
  let found = false;
  for (const [field, value] of Object.entries(result)) {
    const raw = Array.isArray(value) ? value.map(String) : [String(value)];
    if (raw.some(v => matchingIds.includes(v))) {
      console.log(`  НАЙДЕНО: ${field} = ${JSON.stringify(value)}`);
      found = true;
    }
  }
  if (!found) console.log('  Не нашлось ни одного поля с этим ID напрямую.');

  console.log('\n=== На всякий случай — все числовые/массивные поля сделки (для ручного сравнения) ===\n');
  for (const [field, value] of Object.entries(result)) {
    if (value === null || value === '' || value === false) continue;
    if (typeof value === 'number' || Array.isArray(value) || /^\d+$/.test(String(value))) {
      console.log(`  ${field.padEnd(28)} = ${JSON.stringify(value)}`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

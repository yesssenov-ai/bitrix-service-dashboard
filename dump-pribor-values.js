// Dumps the FULL list of values for the "Название прибора." field
// (ufCrmPribor) on smart process 1058 — the previous dump script truncated
// this to 8 items per field. We need the complete id→name mapping so the
// planner sync can translate Bitrix's instrument IDs into readable text.
//
// HOW TO RUN: same as before — commit this file, push, wait for deploy,
// then in Railway Console:  node dump-pribor-values.js

const { b24 } = require('./bitrix');

const ENTITY_TYPE_ID = 1058;
const FIELD_CODE = 'ufCrmPribor';

async function main() {
  const { result } = await b24('crm.item.fields', { entityTypeId: ENTITY_TYPE_ID });
  const field = result?.fields?.[FIELD_CODE];

  if (!field) {
    console.log(`Field ${FIELD_CODE} not found.`);
    return;
  }

  console.log(`${FIELD_CODE} (${field.title}) — type=${field.type}${field.isMultiple ? ' (multiple)' : ''}\n`);

  const items = field.items || [];
  console.log(`Total values: ${items.length}\n`);
  for (const it of items) {
    console.log(`${it.ID}\t${it.VALUE}`);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

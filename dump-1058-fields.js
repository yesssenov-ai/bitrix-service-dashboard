// One-off helper: dumps every field code + label for smart process 1058
// (Заявка на сервис), so we know exactly which UF field codes to read for
// the planner ↔ Bitrix integration (engineer, dates, service type,
// instrument, client).
//
// HOW TO RUN:
//   1. Drop this file into the root of the bitrix-service-dashboard repo
//      (next to bitrix.js), where BITRIX_WEBHOOK is available as an env var
//      (e.g. run it via `railway run node dump-1058-fields.js`, or paste it
//      into a Railway shell / your local .env-loaded terminal).
//   2. node dump-1058-fields.js
//   3. Paste the full output back — that's all we need to wire up the sync.

const { b24 } = require('./bitrix');

const ENTITY_TYPE_ID = 1058; // Заявка на сервис

async function main() {
  console.log(`Fetching field definitions for entityTypeId=${ENTITY_TYPE_ID}...\n`);
  const { result } = await b24('crm.item.fields', { entityTypeId: ENTITY_TYPE_ID });
  const fields = result?.fields || {};

  const rows = Object.entries(fields).map(([code, def]) => ({
    code,
    title: def.title || def.listLabel || '',
    type: def.type,
    isMultiple: !!def.isMultiple,
    items: def.items ? def.items.map(i => `${i.ID}=${i.VALUE}`).slice(0, 8) : undefined,
  }));

  // Print a readable table
  for (const r of rows) {
    console.log(`${r.code}\t| ${r.title}\t| type=${r.type}${r.isMultiple ? ' (multiple)' : ''}`);
    if (r.items) console.log(`    values: ${r.items.join(', ')}${r.items.length === 8 ? ', …' : ''}`);
  }

  console.log(`\nTotal fields: ${rows.length}`);

  // Also grab one real, recent item so we can see actual values (helps
  // spot which of several similarly-named UF fields is the right one).
  try {
    const list = await b24('crm.item.list', {
      entityTypeId: ENTITY_TYPE_ID,
      order: { id: 'desc' },
      select: ['*', 'uf_*'],
      start: 0,
    });
    const sample = list.result?.items?.[0];
    if (sample) {
      console.log('\n── Most recent item (raw), for cross-reference ──');
      console.log(JSON.stringify(sample, null, 2));
    }
  } catch (e) {
    console.log('\n(Could not fetch a sample item — that\'s fine, the field list above is the important part.)', e.message);
  }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

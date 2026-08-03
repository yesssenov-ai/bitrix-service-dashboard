// Run in Railway Console: node build-manufacturer-map.js
// Correlates every deal in deal_manufacturer_reference.json (dealId ->
// resolved manufacturer text, extracted from a Bitrix export) against its
// RAW UF_CRM_1731862648 value fetched live via the API. The field is
// multi-value, so each deal's raw value is an array of one or more IDs —
// handled properly this time (earlier sample-manufacturer-ids.js used the
// whole array as a single grouping key, which silently mixed unrelated
// combinations together).
//
// For deals where the resolved text names exactly ONE manufacturer and the
// raw value is exactly ONE id, that's a clean, certain pairing. Multi-value
// cases are printed separately for manual review.

const fs = require('fs');
const { b24 } = require('./bitrix');

const FIELD = 'UF_CRM_1731862648';

async function main() {
  const reference = JSON.parse(fs.readFileSync('./deal_manufacturer_reference.json', 'utf-8'));
  const dealIds = Object.keys(reference).map(Number);
  console.log(`Сверяю ${dealIds.length} сделок...\n`);

  const idToNames = {}; // rawId -> Set of resolved names seen paired with it (should converge to 1)
  const cleanPairs = {}; // rawId -> name, only from single-value deals
  const multiValueExamples = [];
  let checked = 0, notFound = 0;

  // Batch in chunks of 50 (crm.deal.list filter with @ID array)
  for (let i = 0; i < dealIds.length; i += 50) {
    const batch = dealIds.slice(i, i + 50);
    const { result } = await b24('crm.deal.list', {
      filter: { '@ID': batch },
      select: ['ID', FIELD],
    });
    const deals = result || [];
    const foundIds = new Set(deals.map(d => Number(d.ID)));
    batch.forEach(id => { if (!foundIds.has(id)) notFound++; });

    for (const deal of deals) {
      checked++;
      const resolvedText = reference[deal.ID];
      let raw = deal[FIELD];
      if (raw === null || raw === undefined || raw === '') continue;
      const rawArr = Array.isArray(raw) ? raw : [raw];

      if (rawArr.length === 1 && !resolvedText.includes(',')) {
        const rid = rawArr[0];
        cleanPairs[rid] = resolvedText;
        if (!idToNames[rid]) idToNames[rid] = new Set();
        idToNames[rid].add(resolvedText);
      } else {
        if (multiValueExamples.length < 15) {
          multiValueExamples.push(`  Сделка #${deal.ID}: raw=${JSON.stringify(rawArr)} resolved="${resolvedText}"`);
        }
      }
    }
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`Проверено: ${checked}, не найдено в API: ${notFound}\n`);

  console.log('=== Чистое соответствие ID -> Название (из однозначных сделок) ===\n');
  Object.entries(cleanPairs)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .forEach(([id, name]) => {
      const allNames = [...idToNames[id]];
      const consistent = allNames.length === 1;
      console.log(`  ${id.padEnd(6)} = "${name}"${consistent ? '' : `  ⚠️ ПРОТИВОРЕЧИЕ: также встречалось как ${JSON.stringify(allNames)}`}`);
    });

  console.log(`\n=== Примеры сделок с несколькими значениями (первые ${multiValueExamples.length}) ===\n`);
  multiValueExamples.forEach(e => console.log(e));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

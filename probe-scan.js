// probe-scan.js — scan execution-stage deals and tally the RAW values actually
// stored in the payment fields, so we can hardcode the «Оплата клиент» map
// (iblock 21 is a plain infoblock, not a lists-module list → unreadable via REST).
//
// Run (no args needed): node probe-scan.js
// Paste the output — I'll map each client id to its label.

const { b24 } = require('./bitrix');
const { PIPELINES } = require('./operational');

const FIELDS = {
  UF_CRM_1744195326183: 'Оплата завод (enum 3585-3588)',
  UF_CRM_1731864478:    'Оплата клиент (iblock 21)',
  UF_CRM_1761294746543: 'Оплата клиент (строка, альт.)',
};

function firstOf(v) { return Array.isArray(v) ? v[0] : v; }

async function main() {
  const tally = {};
  for (const f of Object.keys(FIELDS)) tally[f] = {};
  let scanned = 0;

  for (const [cat, cfg] of Object.entries(PIPELINES)) {
    let start = 0;
    for (let page = 0; page < 40; page++) {
      let r;
      try {
        r = await b24('crm.deal.list', {
          filter: { CATEGORY_ID: cat, '@STAGE_ID': cfg.stages },
          select: ['ID', 'COMPANY_ID', ...Object.keys(FIELDS)],
          start,
        });
      } catch (e) { console.log(`  ошибка (воронка ${cat}): ${e.message}`); break; }
      const items = r.result || [];
      scanned += items.length;
      for (const d of items) {
        for (const f of Object.keys(FIELDS)) {
          const v = firstOf(d[f]);
          if (v === undefined || v === null || v === '') continue;
          const key = String(v);
          if (!tally[f][key]) tally[f][key] = { count: 0, example: d.ID };
          tally[f][key].count++;
        }
      }
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
  }

  console.log(`\nПросканировано сделок исполнительной фазы: ${scanned}`);
  for (const [f, label] of Object.entries(FIELDS)) {
    console.log(`\n=== ${label}  (${f}) ===`);
    const entries = Object.entries(tally[f]).sort((a, b) => b[1].count - a[1].count);
    if (!entries.length) { console.log('  (нигде не заполнено)'); continue; }
    entries.forEach(([v, info]) => console.log(`  ${String(v).padEnd(12)} → ${info.count} сделок (напр. #${info.example})`));
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

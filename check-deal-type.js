// Run in Railway Console: node check-deal-type.js
// TYPE_ID looks like the real source of "Тип КП / Договора" (Instrument/
// General lab equipment/Robots/Complex/etc) — a standard crm_status field,
// should resolve cleanly unlike the custom iblock fields we've fought before.
const { b24 } = require('./bitrix');

async function main() {
  const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: 'DEAL_TYPE' } });
  (result || []).forEach(s => console.log(`  ${s.STATUS_ID.padEnd(20)} | ${s.NAME}`));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

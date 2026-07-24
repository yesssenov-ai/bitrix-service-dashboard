// Compares the planner's staff roster (stored server-side now) against
// Bitrix's list of active users, and reports differences — new Bitrix users
// not yet in the planner, and planner staff who no longer show up as active
// in Bitrix. Does NOT change anything automatically: people/roster changes
// are worth a human look before applying.
//
// HOW TO RUN: same as the other one-off scripts — commit, push, wait for
// deploy, then in Railway Console:
//   node sync-bitrix-employees.js

const { pool } = require('./auth');
const { fetchAllActiveUsers } = require('./routes/planner-routes');

function normalize(name) {
  return (name || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function main() {
  // 1. Active Bitrix users (paginated — user.get caps at 50 per page)
  const users = await fetchAllActiveUsers();
  const bitrixNames = users
    .map(u => `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim())
    .filter(Boolean);

  // 2. Current planner roster (the same config the app itself reads)
  const { rows } = await pool.query(`SELECT value FROM ticketsmodule_planner_config WHERE key='depts'`);
  const adminDepts = rows[0]?.value || [];
  const plannerNames = [];
  adminDepts.forEach(dept => dept.members.forEach(m => plannerNames.push(m.name)));

  const bitrixNorm = new Set(bitrixNames.map(normalize));
  const plannerNorm = new Set(plannerNames.map(normalize));

  const newInBitrix = bitrixNames.filter(n => !plannerNorm.has(normalize(n)));
  const missingFromBitrix = plannerNames.filter(n => !bitrixNorm.has(normalize(n)));

  console.log(`Bitrix active users: ${bitrixNames.length}`);
  console.log(`Planner roster: ${plannerNames.length}\n`);

  console.log(`── In Bitrix but NOT in planner (${newInBitrix.length}) ──`);
  newInBitrix.forEach(n => console.log('  + ' + n));

  console.log(`\n── In planner but NOT active in Bitrix (${missingFromBitrix.length}) ──`);
  missingFromBitrix.forEach(n => console.log('  - ' + n));

  console.log(`\nNote: name matching is exact (case/whitespace-insensitive) — spelling`);
  console.log(`differences (e.g. "Аскат Кобей" vs "Аскат Көбей") will show up as both`);
  console.log(`missing and new for the same person. Nothing has been changed —`);
  console.log(`this is a comparison only.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('Error:', e.message); process.exit(1); });

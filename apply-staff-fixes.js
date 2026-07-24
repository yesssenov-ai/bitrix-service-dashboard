// One-off: applies the two things discussed —
//   1. Fixes "Аскат Кобей" → "Аскат Көбей" (matches constants.js USERS map)
//   2. Runs the same one-directional Bitrix→planner staff sync the "Обновить
//      с Bitrix" button uses, adding every active Bitrix employee not yet
//      in the roster (service accounts excluded).
//
// HOW TO RUN: commit, push, wait for deploy, then in Railway Console:
//   node apply-staff-fixes.js

const { pool } = require('./auth');
const { syncStaffFromBitrix } = require('./routes/planner-routes');

async function main() {
  // 1. Fix Аскат's spelling
  const { rows } = await pool.query(`SELECT value FROM ticketsmodule_planner_config WHERE key='depts'`);
  const adminDepts = rows[0]?.value || [];
  let fixed = false;
  adminDepts.forEach(d => d.members.forEach(m => {
    if (m.name === 'Аскат Кобей') { m.name = 'Аскат Көбей'; fixed = true; }
  }));
  if (fixed) {
    await pool.query(
      `UPDATE ticketsmodule_planner_config SET value=$1, updated_at=NOW() WHERE key='depts'`,
      [JSON.stringify(adminDepts)]
    );
    console.log('Fixed: Аскат Кобей → Аскат Көбей');
  } else {
    console.log('"Аскат Кобей" not found verbatim — no rename applied (check spelling manually).');
  }

  // 2. Pull in missing active Bitrix employees
  const result = await syncStaffFromBitrix();
  console.log(`\nSync from Bitrix: ${result.added} new employee(s) added, ${result.idBackfilled} existing entries linked to a Bitrix user ID, out of ${result.totalBitrixUsers} active Bitrix users checked.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('Error:', e.message); process.exit(1); });

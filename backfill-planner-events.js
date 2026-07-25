// One-off backfill: syncs EVERY existing Заявка на сервис (1058) item into
// the planner. This is now the same reconciliation sweep that also runs
// automatically every 10 minutes in the background (see server.js) — this
// script just lets you trigger it manually and see the result immediately.
// Safe to run more than once — upserts by bitrix_item_id.
//
// HOW TO RUN: commit, push, wait for deploy, then in Railway Console:
//   node backfill-planner-events.js

const { reconcileAllPlannerEvents } = require('./routes/relations-routes');

reconcileAllPlannerEvents()
  .then(({ checked, errors }) => {
    console.log(`\nDone. Checked ${checked} requests — ${errors} failed (see logs above for details; ops chat was alerted if any did).`);
    process.exit(0);
  })
  .catch(e => { console.error('Error:', e.message); process.exit(1); });

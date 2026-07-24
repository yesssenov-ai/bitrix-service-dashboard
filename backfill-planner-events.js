// One-off backfill: syncs EVERY existing Заявка на сервис (1058) item into
// the planner, using the exact same logic the live webhook uses going
// forward. Safe to run more than once — syncPlannerEvent upserts by
// bitrix_item_id, so re-running just re-applies the same result.
//
// HOW TO RUN: same as the other one-off scripts — commit, push, wait for
// deploy, then in Railway Console:
//   node backfill-planner-events.js

const { syncPlannerEvent } = require('./routes/relations-routes');
const { b24 } = require('./bitrix');

const ENTITY_TYPE_ID = 1058;

async function main() {
  let start = 0;
  let total = 0, synced = 0, skipped = 0;

  while (true) {
    const { result, total: totalCount, next } = await b24('crm.item.list', {
      entityTypeId: ENTITY_TYPE_ID,
      select: ['*', 'uf_*'],
      order: { id: 'asc' },
      start,
    });
    const items = result?.items || [];
    if (!items.length) break;

    for (const item of items) {
      total++;
      const before = await hasPlannerEvent(item.id);
      await syncPlannerEvent(item, item.id);
      const after = await hasPlannerEvent(item.id);
      if (after) synced++; else skipped++;
      if (total % 25 === 0) console.log(`...processed ${total}${totalCount ? '/' + totalCount : ''}`);
    }

    if (next === undefined || items.length < 50) break;
    start = next;
  }

  console.log(`\nDone. Checked ${total} requests — ${synced} now have a planner event, ${skipped} skipped (missing required fields or unmapped engineer).`);
}

// Lightweight check via our own DB, to report accurate before/after counts
const { pool } = require('./auth');
async function hasPlannerEvent(itemId) {
  const { rows } = await pool.query('SELECT 1 FROM ticketsmodule_planner_events WHERE bitrix_item_id=$1', [itemId]);
  return rows.length > 0;
}

main().then(() => process.exit(0)).catch(e => { console.error('Error:', e.message); process.exit(1); });

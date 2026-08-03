// Run in Railway Console: node sync-stats-full.js
// One-time backfill — pulls every deal across all 4 pipelines into
// ticketsmodule_stat_deals. Safe to re-run any time (upserts by deal_id).
const { fullSync } = require('./stats-sync');

fullSync().then(() => process.exit(0)).catch(e => { console.error('Sync failed:', e.message); process.exit(1); });

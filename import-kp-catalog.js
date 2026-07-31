// Imports a catalog Excel file as a new version in the DB, and activates it.
// Safe to re-run with an updated file later — each run creates a NEW
// version (old ones stay intact for rollback), matched by stable_key so
// price changes update existing items instead of duplicating them.
//
// HOW TO RUN (Railway Console):
//   node import-kp-catalog.js <path-to-xlsx> "<note about this version>"
//
// Prefer the web upload in the KP module's "Каталог" tab going forward —
// this script remains as a console fallback.

const fs = require('fs');
const { importCatalogVersion } = require('./kp-catalog-import');

async function main() {
  const filePath = process.argv[2];
  const note = process.argv[3] || '';
  if (!filePath) { console.error('Usage: node import-kp-catalog.js <path-to-xlsx> "<note>"'); process.exit(1); }

  const buffer = fs.readFileSync(filePath);
  const result = await importCatalogVersion({ buffer, filename: filePath.split('/').pop(), note });

  result.warnings.forEach(w => console.warn('⚠️ ', w));
  console.log(`\n✅ Imported catalog version #${result.versionId}: ${result.totalItems} items across ${result.perCategory.length} categories.`);
  result.perCategory.forEach(c => console.log(`   ${c.name} (${c.slug}): ${c.count}`));
}

main().then(() => process.exit(0)).catch(e => { console.error('Import failed:', e.message); process.exit(1); });

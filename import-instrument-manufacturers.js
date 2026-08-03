// Run in Railway Console: node import-instrument-manufacturers.js
// Loads instrument_manufacturer_map.json (75 instrument names -> manufacturer,
// built and verified from a real Bitrix export where every distinct
// instrument name mapped to exactly one manufacturer with zero exceptions)
// into the DB. Safe to re-run — upserts by instrument_name.

const fs = require('fs');
const { pool } = require('./auth');

async function main() {
  const mapping = JSON.parse(fs.readFileSync('./instrument_manufacturer_map.json', 'utf-8'));
  const entries = Object.entries(mapping);
  console.log(`Загружаю ${entries.length} пар прибор->производитель...`);

  for (const [name, manufacturer] of entries) {
    await pool.query(
      `INSERT INTO ticketsmodule_stat_instrument_manufacturer (instrument_name, manufacturer, updated_at)
       VALUES ($1,$2,NOW())
       ON CONFLICT (instrument_name) DO UPDATE SET manufacturer=$2, updated_at=NOW()`,
      [name, manufacturer]
    );
  }
  console.log('✅ Готово.');
}

main().then(() => process.exit(0)).catch(e => { console.error('Import failed:', e.message); process.exit(1); });

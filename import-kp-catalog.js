// Imports a catalog Excel file as a new version in the DB, and activates it.
// Safe to re-run with an updated file later — each run creates a NEW
// version (old ones stay intact for rollback), matched by stable_key so
// price changes update existing items instead of duplicating them.
//
// HOW TO RUN: commit, push, wait for deploy, upload the .xlsx somewhere
// reachable (or place it in the repo root temporarily), then in Railway
// Console:
//   node import-kp-catalog.js <path-to-xlsx> "<note about this version>"

const fs = require('fs');
const { pool } = require('./auth');
const { parseCatalogWorkbook, stableHash } = require('./kp-catalog-lib');

// Seed content for "Услуги" — there's no source sheet for this yet, so this
// mirrors the example КП's "6. Услуги" section as a starting point. Adjust
// via the admin UI once built, or edit this list before running.
const SERVICE_ITEMS = [
  { name: 'Комплект инструментов для проборазделки: в состав поставки входит комплект ручного инструмента, необходимого для выполнения операций пробоподготовки и проборазделки, включая: совки, шпатели, щётки, металлические лопатки, делители проб, а также прочие вспомогательные принадлежности.' },
  { name: 'Проработка перечня нормативных документов для выполнения вспомогательных аналитических работ.' },
  { name: 'Обучение персонала: проводится обучение сотрудников Заказчика по эксплуатации оборудования, включая теоретическую и практическую подготовку, а также требования по технике безопасности. Обучение выполняется специалистами Поставщика на площадке Заказчика или в учебном центре с выдачей сертификатов.' },
  { name: 'Отработка процессов в соответствии с ГОСТ 14180-80 «Руды и концентраты цветных металлов. Методы подготовки проб к анализу» и требуемым количеством проб в сутки; проводится настройка и апробация процессов пробоподготовки и проборазделки.' },
];

async function main() {
  const filePath = process.argv[2];
  const note = process.argv[3] || '';
  if (!filePath) { console.error('Usage: node import-kp-catalog.js <path-to-xlsx> "<note>"'); process.exit(1); }

  const buffer = fs.readFileSync(filePath);
  const { categories, items, warnings } = parseCatalogWorkbook(buffer);
  warnings.forEach(w => console.warn('⚠️ ', w));

  // Add the Услуги category + its seeded items
  categories.push({ slug: 'uslugi', name: 'Услуги' });
  SERVICE_ITEMS.forEach((s, i) => {
    items.push({
      stable_key: stableHash('uslugi|' + s.name.toLowerCase().trim()),
      category_slug: 'uslugi', section_name: null, item_no: String(i + 1),
      name: s.name, unit_price: null, is_included: true, specs: null, power_kw: null,
      sort_order: i + 1,
    });
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure categories exist (id stable via slug, name can be updated)
    const categoryIds = {};
    for (let i = 0; i < categories.length; i++) {
      const c = categories[i];
      const { rows } = await client.query(
        `INSERT INTO ticketsmodule_kp_categories (slug, name, sort_order) VALUES ($1,$2,$3)
         ON CONFLICT (slug) DO UPDATE SET name=$2 RETURNING id`,
        [c.slug, c.name, i]
      );
      categoryIds[c.slug] = rows[0].id;
    }

    // Deactivate the currently-active version, create the new one active
    await client.query('UPDATE ticketsmodule_kp_catalog_versions SET active=false');
    const { rows: verRows } = await client.query(
      `INSERT INTO ticketsmodule_kp_catalog_versions (filename, active, note) VALUES ($1, true, $2) RETURNING id`,
      [filePath.split('/').pop(), note]
    );
    const versionId = verRows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO ticketsmodule_kp_items
          (stable_key, catalog_version_id, category_id, section_name, item_no, name, unit_price, is_included, specs, power_kw, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [item.stable_key, versionId, categoryIds[item.category_slug], item.section_name, item.item_no,
         item.name, item.unit_price, item.is_included, item.specs, item.power_kw, item.sort_order]
      );
    }

    await client.query('COMMIT');
    console.log(`\n✅ Imported catalog version #${versionId}: ${items.length} items across ${categories.length} categories.`);
    categories.forEach(c => {
      const count = items.filter(i => i.category_slug === c.slug).length;
      console.log(`   ${c.name} (${c.slug}): ${count}`);
    });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Import failed:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

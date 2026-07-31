const { pool } = require('./auth');
const { parseCatalogWorkbook, stableHash } = require('./kp-catalog-lib');

// Seed content for "Услуги" — there's no source Excel sheet for this, so this
// mirrors the example КП's "6. Услуги" section as a starting point. Every
// catalog version must include it too, since a request's item browser only
// ever shows items from whichever version is currently active.
const SERVICE_ITEMS = [
  { name: 'Комплект инструментов для проборазделки: в состав поставки входит комплект ручного инструмента, необходимого для выполнения операций пробоподготовки и проборазделки, включая: совки, шпатели, щётки, металлические лопатки, делители проб, а также прочие вспомогательные принадлежности.' },
  { name: 'Проработка перечня нормативных документов для выполнения вспомогательных аналитических работ.' },
  { name: 'Обучение персонала: проводится обучение сотрудников Заказчика по эксплуатации оборудования, включая теоретическую и практическую подготовку, а также требования по технике безопасности. Обучение выполняется специалистами Поставщика на площадке Заказчика или в учебном центре с выдачей сертификатов.' },
  { name: 'Отработка процессов в соответствии с ГОСТ 14180-80 «Руды и концентраты цветных металлов. Методы подготовки проб к анализу» и требуемым количеством проб в сутки; проводится настройка и апробация процессов пробоподготовки и проборазделки.' },
];

// Parses the given .xlsx buffer, inserts it as a brand-new catalog version
// (activating it, deactivating the previous one), and returns a summary.
// Old versions are never modified or deleted — this is what makes rollback
// possible (just reactivate an earlier version_id).
async function importCatalogVersion({ buffer, filename, note, uploadedBy }) {
  const { categories, items, warnings } = parseCatalogWorkbook(buffer);

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

    await client.query('UPDATE ticketsmodule_kp_catalog_versions SET active=false');
    const { rows: verRows } = await client.query(
      `INSERT INTO ticketsmodule_kp_catalog_versions (filename, uploaded_by, active, note) VALUES ($1,$2,true,$3) RETURNING id`,
      [filename, uploadedBy || null, note || null]
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
    const perCategory = categories.map(c => ({
      slug: c.slug, name: c.name, count: items.filter(i => i.category_slug === c.slug).length,
    }));
    return { versionId, totalItems: items.length, perCategory, warnings };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { importCatalogVersion, SERVICE_ITEMS };

// Run in Railway Console: node import-bonus-tariffs.js <path-to-filled-instruments-xlsx>
// Safe to re-run — categories are upserted by slug, instrument mappings are
// upserted by bitrix_pribor_id, so re-importing an updated file just updates
// existing rows instead of duplicating.

const fs = require('fs');
const XLSX = require('xlsx');
const { pool } = require('./auth');

const CATEGORIES = [
  ['UV-VIS','УФ-ВИД и УФ-ВИД-БИК Спектрометры',150,300],
  ['FLR','Флуоресцентные спектрометры',150,300],
  ['IR-F','ИК-Фурье спектрометры',150,500],
  ['RS','Рамановские спектрометры',300,700],
  ['LDIR','LDIR Спектрометры',300,700],
  ['AAS','Атомно-абсорбционные спектрометры',250,750],
  ['MP-AES','Атомно-эмиссионные спектрометры с микроволновой плазмой',250,750],
  ['ICP-OES','Оптико-эмиссионные спектрометры с ИСП',250,1250],
  ['ICP-MS','Масс-спектрометры с ИСП',500,2000],
  ['GC','Газовые хроматографы',250,750],
  ['GC-MS','Газовые хроматографы с масс-детектором',300,1200],
  ['GC-QTOF','ГХ-QTOF',500,1000],
  ['HPLC','Высокоэффективные жидкостные хроматографы',250,750],
  ['HPLC-MS','ВЭЖХ с масс-детектором',300,1200],
  ['HPLC-QTOF','ВЭЖХ-QTOF',500,1000],
  ['CE','Капиллярный электрофорез',250,500],
  ['Epsilon EXRF','Энергодисперсионные РФС Epsilon',250,750],
  ['Zetium EXRF','Энергодисперсионные РФС Zetium',500,2000],
  ['WXRF','Волнодисперсионные РФС',250,650],
  ['Aeris XRD','Рентгеновский дифрактометр',250,1250],
  ['LDPA','Лазерная дифракция',200,400],
  ['IA','Анализ отображения',200,400],
  ['DDL','Динамическое рассеивание света',300,500],
  ['NaPA','Отслеживание наночастиц',300,500],
];

async function main() {
  const filePath = process.argv[2];
  if (!filePath) { console.error('Usage: node import-bonus-tariffs.js <path-to-xlsx>'); process.exit(1); }

  const categoryIds = {};
  for (const [slug, name, install, methodical] of CATEGORIES) {
    const { rows } = await pool.query(
      `INSERT INTO ticketsmodule_bonus_tariff_categories (slug, name, install_usd, methodical_usd)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO UPDATE SET name=$2, install_usd=$3, methodical_usd=$4
       RETURNING id`,
      [slug, name, install, methodical]
    );
    categoryIds[slug] = rows[0].id;
  }
  console.log(`✅ ${CATEGORIES.length} категорий тарифа загружено.`);

  const wb = XLSX.read(fs.readFileSync(filePath));
  const ws = wb.Sheets['Приборы'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

  let mapped = 0, skipped = 0;
  for (let r = 1; r < rows.length; r++) {
    const [id, name, categorySlug] = rows[r];
    if (!id || !name) continue;
    const catId = categorySlug && categoryIds[categorySlug] ? categoryIds[categorySlug] : null;
    if (!catId) { skipped++; continue; }

    await pool.query(
      `INSERT INTO ticketsmodule_instrument_category_map (bitrix_pribor_id, pribor_name, category_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (bitrix_pribor_id) DO UPDATE SET pribor_name=$2, category_id=$3`,
      [id, name, catId]
    );
    mapped++;
  }
  console.log(`✅ Сопоставлено приборов: ${mapped}. Пропущено (без категории): ${skipped}.`);
}

main().then(() => process.exit(0)).catch(e => { console.error('Import failed:', e.message); process.exit(1); });

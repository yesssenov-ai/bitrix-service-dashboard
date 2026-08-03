// Run in Railway Console: node dump-list-35.js
// List ID 35 ("Название прибора") is the source of the cascading
// Производитель -> Тип анализа fields. In Bitrix's Универсальные списки,
// a cascading/dependent field is usually built as SECTIONS (top level =
// Производитель) containing ELEMENTS (leaf level = Тип анализа). This
// dumps both, fully, straight from source.

const { b24 } = require('./bitrix');

const IBLOCK_TYPE_ID = 'lists';
const IBLOCK_ID = 35;

async function main() {
  console.log('=== Разделы (секции) — предположительно Производители ===\n');
  try {
    const { result } = await b24('lists.section.get', { IBLOCK_TYPE_ID, IBLOCK_ID });
    (result || []).forEach(s => console.log(`  ID=${s.ID} | NAME="${s.NAME}"`));
    console.log(`\n  Всего разделов: ${(result || []).length}`);
  } catch (e) {
    console.error('  Ошибка lists.section.get:', e.message);
  }

  console.log('\n=== Элементы — предположительно Тип анализа / конкретные приборы ===\n');
  try {
    const { result } = await b24('lists.element.get', { IBLOCK_TYPE_ID, IBLOCK_ID });
    (result || []).forEach(el => console.log(`  ID=${el.ID} | SECTION=${el.IBLOCK_SECTION_ID} | NAME="${el.NAME}"`));
    console.log(`\n  Всего элементов: ${(result || []).length}`);
  } catch (e) {
    console.error('  Ошибка lists.element.get:', e.message);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

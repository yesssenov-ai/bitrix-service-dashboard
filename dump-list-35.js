// Run in Railway Console: node dump-list-35.js
// List ID 35 ("Название прибора") is the source of the cascading
// Производитель -> Тип анализа fields. In Bitrix's Универсальные списки,
// a cascading/dependent field is usually built as SECTIONS (top level =
// Производитель) containing ELEMENTS (leaf level = Тип анализа). This
// dumps both, fully, straight from source.

const { b24 } = require('./bitrix');

const IBLOCK_TYPE_ID = 'lists';

async function dumpList(iblockId, label) {
  console.log(`\n${'='.repeat(10)} Список "${label}" (ID=${iblockId}) ${'='.repeat(10)}`);
  console.log('--- Разделы ---');
  try {
    const { result } = await b24('lists.section.get', { IBLOCK_TYPE_ID, IBLOCK_ID: iblockId });
    (result || []).forEach(s => console.log(`  ID=${s.ID} | NAME="${s.NAME}"`));
    console.log(`  Всего разделов: ${(result || []).length}`);
  } catch (e) { console.error('  Ошибка lists.section.get:', e.message); }

  console.log('--- Элементы ---');
  try {
    const { result } = await b24('lists.element.get', { IBLOCK_TYPE_ID, IBLOCK_ID: iblockId });
    (result || []).forEach(el => console.log(`  ID=${el.ID} | SECTION=${el.IBLOCK_SECTION_ID} | NAME="${el.NAME}"`));
    console.log(`  Всего элементов: ${(result || []).length}`);
  } catch (e) { console.error('  Ошибка lists.element.get:', e.message); }
}

async function main() {
  // Sanity check first: list 17 is known to have ~27 real values (Город/
  // Область/Страна) — if THIS also comes back empty, the problem is the
  // API call format, not which list ID we picked for list 35.
  await dumpList(17, 'Город / Область / Страна (УС) — контрольная проверка');
  await dumpList(35, 'Название прибора');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

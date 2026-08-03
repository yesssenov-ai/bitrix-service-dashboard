// Run in Railway Console: node dump-list-35.js
// List ID 35 ("Название прибора") is the source of the cascading
// Производитель -> Тип анализа fields. In Bitrix's Универсальные списки,
// a cascading/dependent field is usually built as SECTIONS (top level =
// Производитель) containing ELEMENTS (leaf level = Тип анализа). This
// dumps both, fully, straight from source.

const { b24 } = require('./bitrix');

async function dumpList(iblockTypeId, iblockId, label) {
  console.log(`\n${'='.repeat(10)} Список "${label}" (TYPE=${iblockTypeId}, ID=${iblockId}) ${'='.repeat(10)}`);
  console.log('--- Разделы ---');
  try {
    const { result } = await b24('lists.section.get', { IBLOCK_TYPE_ID: iblockTypeId, IBLOCK_ID: iblockId });
    (result || []).forEach(s => console.log(`  ID=${s.ID} | NAME="${s.NAME}"`));
    console.log(`  Всего разделов: ${(result || []).length}`);
  } catch (e) { console.error('  Ошибка lists.section.get:', e.message); }

  console.log('--- Элементы ---');
  try {
    const { result } = await b24('lists.element.get', { IBLOCK_TYPE_ID: iblockTypeId, IBLOCK_ID: iblockId });
    (result || []).forEach(el => console.log(`  ID=${el.ID} | SECTION=${el.IBLOCK_SECTION_ID} | NAME="${el.NAME}"`));
    console.log(`  Всего элементов: ${(result || []).length}`);
  } catch (e) { console.error('  Ошибка lists.element.get:', e.message); }
}

async function main() {
  // Try every plausible IBLOCK_TYPE_ID Bitrix uses for "Универсальные
  // списки" / CRM custom lists — 'lists' only showed 17 results (IDs
  // 16-36), so Производитель/Тип анализа may live under a different type.
  const typeIds = ['lists', 'lists_socnet', 'bitrix_processes', 'crm', 'sprav'];
  for (const typeId of typeIds) {
    console.log(`\n\n########## IBLOCK_TYPE_ID = "${typeId}" ##########`);
    try {
      const { result } = await b24('lists.get', { IBLOCK_TYPE_ID: typeId });
      const lists = result || [];
      console.log(`Найдено списков: ${lists.length}`);
      lists.forEach(l => console.log(`  ID=${l.ID} | NAME="${l.NAME}"`));
      const candidates = lists.filter(l => /производ|тип\s*анализ|manufactur|brand/i.test(l.NAME || ''));
      for (const c of candidates) {
        await dumpList(typeId, c.ID, c.NAME);
      }
    } catch (e) {
      console.error(`  Ошибка lists.get для типа "${typeId}":`, e.message);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

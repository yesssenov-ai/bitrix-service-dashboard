// Run in Railway Console: node discover-iblock.js
// The "Производитель (зависимое поле)" is an iblock_element field, backed
// by a Bitrix "Универсальные списки" (Universal Lists) iblock. Sampling
// real deals can never guarantee completeness (an option might exist but
// never have been used yet) — this pulls the list straight from its source.
//
// Strategy: list all iblock types, then all iblocks of each type, looking
// for one whose name matches "Производит" (Производитель) or similar —
// then dump every element of that iblock with its real ID.

const { b24 } = require('./bitrix');

async function main() {
  console.log('=== 1) Типы инфоблоков (iblock.type.list) ===\n');
  try {
    const { result } = await b24('iblock.type.list', {});
    (result || []).forEach(t => console.log(`  ${t.ID} | ${JSON.stringify(t.NAME)}`));
  } catch (e) { console.error('Ошибка iblock.type.list:', e.message); }

  console.log('\n=== 2) Все инфоблоки (iblock.list.get, без фильтра по типу) ===\n');
  let allBlocks = [];
  try {
    const { result } = await b24('iblock.list.get', {});
    allBlocks = result || [];
    allBlocks.forEach(b => console.log(`  ID=${b.ID} | TYPE=${b.IBLOCK_TYPE_ID} | NAME="${b.NAME}"`));
  } catch (e) { console.error('Ошибка iblock.list.get:', e.message); }

  console.log('\n=== 3) Похожие на "Производитель" ===\n');
  const candidates = allBlocks.filter(b => /производ/i.test(b.NAME || ''));
  if (!candidates.length) console.log('  Ничего не нашлось по названию — возможно, называется иначе. Смотри полный список выше.');
  candidates.forEach(b => console.log(`  НАЙДЕНО: ID=${b.ID} | NAME="${b.NAME}"`));

  for (const block of candidates) {
    console.log(`\n=== 4) Все элементы инфоблока "${block.NAME}" (ID=${block.ID}) ===\n`);
    try {
      const { result } = await b24('iblock.element.get', { iblockId: block.ID });
      (result || []).forEach(el => console.log(`  ID=${el.ID} | NAME="${el.NAME}"`));
      console.log(`\n  Всего элементов: ${(result || []).length}`);
    } catch (e) {
      console.error(`  Ошибка iblock.element.get для ${block.ID}:`, e.message);
      try {
        const { result } = await b24('iblock.section.list', { iblockId: block.ID });
        console.log('  (пробуем через iblock.section.list вместо элементов)');
        (result || []).forEach(s => console.log(`  ID=${s.ID} | NAME="${s.NAME}"`));
      } catch (e2) {
        console.error(`  Ошибка iblock.section.list для ${block.ID}:`, e2.message);
      }
    }
  }

  console.log('\n=== 5) Попытка через lists.* (Универсальные списки, другой API) ===\n');
  try {
    const { result } = await b24('lists.get', { IBLOCK_TYPE_ID: 'lists' });
    (result || []).forEach(l => console.log(`  ID=${l.ID} | NAME="${l.NAME}"`));
    const listCandidates = (result || []).filter(l => /производ/i.test(l.NAME || ''));
    for (const list of listCandidates) {
      console.log(`\n  НАЙДЕН список "${list.NAME}" (ID=${list.ID}) — элементы:`);
      const { result: elements } = await b24('lists.element.get', { IBLOCK_TYPE_ID: 'lists', IBLOCK_ID: list.ID });
      (elements || []).forEach(el => console.log(`    ID=${el.ID} | NAME="${el.NAME}"`));
    }
  } catch (e) {
    console.error('  Ошибка lists.get:', e.message);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

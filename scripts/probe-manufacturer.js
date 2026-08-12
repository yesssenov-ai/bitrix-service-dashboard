// Проверка v2: поле «Производитель» — тип iblock_element (на сделке лежит ID
// элемента справочника-инфоблока). Пытаемся прочитать справочник через lists.*
// и собрать карту ID→имя. Если получится — робот не нужен, чиним код.
//
// ЗАПУСК (нужен только BITRIX_WEBHOOK): node scripts/probe-manufacturer.js
const { b24 } = require('../bitrix');

const MANUF_CODE = 'UF_CRM_1731862648';
const INSTR_CODE = 'UF_CRM_NAME_PRIOBOR';

async function call(m, p) { try { return await b24(m, p || {}); } catch (e) { return { __error: e.message }; } }

async function main() {
  const fields = (await call('crm.deal.userfield.list', {})).result || [];
  const manuf = fields.find(f => f.FIELD_NAME === MANUF_CODE);
  if (!manuf) { console.log('❌ поле не найдено'); return; }

  console.log('=== Настройки поля «Производитель» ===');
  console.log('тип:', manuf.USER_TYPE_ID);
  console.log('SETTINGS:', JSON.stringify(manuf.SETTINGS));
  const IBLOCK_ID = manuf.SETTINGS?.IBLOCK_ID;
  const IBLOCK_TYPE_ID = manuf.SETTINGS?.IBLOCK_TYPE_ID;
  console.log(`→ IBLOCK_ID=${IBLOCK_ID}  IBLOCK_TYPE_ID=${IBLOCK_TYPE_ID}`);

  // Пробуем прочитать элементы справочника разными способами
  const typeGuesses = [IBLOCK_TYPE_ID, 'lists', 'bitrix_processes', 'lists_socnet'].filter(Boolean);
  let elements = null, usedType = null;
  for (const t of [...new Set(typeGuesses)]) {
    const r = await call('lists.element.get', { IBLOCK_TYPE_ID: t, IBLOCK_ID, ELEMENT_ORDER: { ID: 'ASC' } });
    if (r.__error) { console.log(`  lists.element.get(type=${t}) → ошибка: ${r.__error}`); continue; }
    if (Array.isArray(r.result) && r.result.length) { elements = r.result; usedType = t; console.log(`  ✅ прочитано через IBLOCK_TYPE_ID=${t}: элементов ${r.result.length}`); break; }
    console.log(`  lists.element.get(type=${t}) → пусто`);
  }

  const id2name = {};
  if (elements) {
    console.log('\n=== Справочник производителей (ID → имя) ===');
    for (const el of elements) {
      const id = el.ID || el.id;
      const name = el.NAME || el.name || (el.PROPERTY_ && Object.values(el.PROPERTY_)[0]);
      id2name[String(id)] = name;
      console.log(`   ${id}  →  ${name}`);
    }
  }

  // Сырые значения на сделках + резолв
  const deals = (await call('crm.deal.list', {
    filter: { [`!${MANUF_CODE}`]: '', '@CATEGORY_ID': ['0', '1', '2', '3'] },
    select: ['ID', MANUF_CODE, INSTR_CODE], order: { ID: 'DESC' },
  })).result || [];
  console.log(`\n=== Сырые значения (20 сделок) ===`);
  let hit = 0, tot = 0;
  for (const d of deals.slice(0, 20)) {
    const raw = d[MANUF_CODE]; tot++;
    const name = id2name[String(raw)];
    if (name) hit++;
    console.log(`  #${d.ID}  ID=${raw}  →  ${name || '?'}   [прибор: ${d[INSTR_CODE] || '—'}]`);
  }

  console.log('\n=== ИТОГ ===');
  if (elements && hit === tot && tot > 0) {
    console.log(`✅ СПРАВОЧНИК ЧИТАЕТСЯ (${elements.length} брендов), резолв ${hit}/${tot}. Робот НЕ нужен — я захардкожу карту ID→бренд и правлю код. Пришли мне ВЕСЬ список «ID → имя» выше.`);
  } else if (elements && hit > 0) {
    console.log(`⚠️ читается частично (${hit}/${tot}). Пришли вывод.`);
  } else {
    console.log(`❌ справочник через lists.* не читается (обычный инфоблок, как оплата клиента). Тогда либо робот, либо ты дашь мне список ID→бренд из админки инфоблока. Пришли строки SETTINGS и ошибки выше.`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error('Ошибка:', e.message); process.exit(1); });

// Тест форматов записи файлов в МНОЖЕСТВЕННОЕ файловое поле 1066.
// Запуск в Railway Console:
//   node scripts/test-file-push.js <itemId> [fieldCode]
// itemId — id тестовой закупки (1066). fieldCode — по умолчанию поле «Счет на оплату».
// Скрипт по очереди пробует форматы, после каждого читает поле и печатает,
// сколько файлов в нём оказалось. Так найдём формат, который реально прикрепляет.

const { b24 } = require('../bitrix');
const ENTITY = 1066;

const itemId = Number(process.argv[2]);
let fieldCode = process.argv[3] || null;

const b64 = s => Buffer.from(s).toString('base64');
const F1 = ['test-1.txt', b64('hello one')];
const F2 = ['test-2.txt', b64('hello two')];

async function countFiles() {
  const { result } = await b24('crm.item.get', { entityTypeId: ENTITY, id: itemId });
  const v = (result && result.item) ? result.item[fieldCode] : null;
  const arr = Array.isArray(v) ? v : (v ? [v] : []);
  return { n: arr.length, ids: arr.map(f => f && (f.id || f.ID)) };
}
async function clear() { try { await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: '' } }); } catch (e) {} }
async function tryFormat(name, value) {
  await clear();
  let err = null;
  try { await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: value } }); }
  catch (e) { err = e.message; }
  const c = await countFiles();
  console.log(`  [${name}] ${err ? 'ОШИБКА: ' + err : 'ok'} → файлов в поле: ${c.n}`);
  return c;
}

(async () => {
  if (!itemId) { console.log('Укажите itemId: node scripts/test-file-push.js <itemId> [fieldCode]'); process.exit(1); }

  if (!fieldCode) {
    const { result } = await b24('crm.item.fields', { entityTypeId: ENTITY });
    const fields = (result && result.fields) || {};
    const hit = Object.entries(fields).find(([, f]) => String(f.type).toLowerCase() === 'file' && /сч[её]т.*оплат/i.test(String(f.title || '')));
    fieldCode = hit ? hit[0] : null;
    if (!fieldCode) { console.log('Не нашли поле «Счет на оплату» — укажите fieldCode вручную.'); process.exit(1); }
    console.log('Поле по умолчанию:', fieldCode, '«' + (fields[fieldCode].title || '') + '», multiple=' + !!fields[fieldCode].isMultiple);
  }

  console.log(`\n=== Тест форматов на элементе #${itemId}, поле ${fieldCode} ===`);

  // 1) массив объектов fileData
  await tryFormat('A: [{fileData:[n,b]}, {fileData:[n,b]}]', [{ fileData: F1 }, { fileData: F2 }]);
  // 2) массив пар [name, base64]
  await tryFormat('B: [[n,b],[n,b]]', [F1, F2]);
  // 3) один объект (как в старом рабочем коде) — сколько ляжет?
  await tryFormat('C: {fileData:[n,b]} (одиночный)', { fileData: F1 });
  // 4) массив из ОДНОГО объекта
  await tryFormat('D: [{fileData:[n,b]}] (массив из одного)', [{ fileData: F1 }]);
  // 5) массив из одной пары
  await tryFormat('E: [[n,b]] (массив из одной пары)', [F1]);

  // 6) ДОПИСЫВАНИЕ: сначала один, потом добавить второй, сохранив существующий по id
  console.log('  --- дописывание (append) ---');
  await clear();
  await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: [{ fileData: F1 }] } }).catch(() => {});
  let after1 = await countFiles();
  console.log(`  после первого: ${after1.n}, ids=${JSON.stringify(after1.ids)}`);
  const ids = after1.ids.filter(Boolean);
  // F: существующие как числа-id + новый fileData
  try { await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: [...ids, { fileData: F2 }] } }); } catch (e) { console.log('  F ошибка:', e.message); }
  console.log(`  [F: [id, {fileData}]] → ${(await countFiles()).n}`);
  // G: существующие как {id} + новый fileData
  await clear();
  await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: [{ fileData: F1 }] } }).catch(() => {});
  const ids2 = (await countFiles()).ids.filter(Boolean);
  try { await b24('crm.item.update', { entityTypeId: ENTITY, id: itemId, fields: { [fieldCode]: [...ids2.map(id => ({ id })), { fileData: F2 }] } }); } catch (e) { console.log('  G ошибка:', e.message); }
  console.log(`  [G: [{id},{fileData}]] → ${(await countFiles()).n}`);

  await clear();
  console.log('\n=== ГОТОВО. Пришлите вывод: где «файлов: 2» — тот формат и верный. ===');
  process.exit(0);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });

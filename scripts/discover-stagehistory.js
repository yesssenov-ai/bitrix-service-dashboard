#!/usr/bin/env node
// Probe истории стадий — нужен, чтобы считать длительность каждого этапа пути
// (сколько дней сделка/закупка/логистика провела на каждой стадии). НИЧЕГО НЕ
// МЕНЯЕТ. Проверяем метод crm.stagehistory.list для Сделок(2), Закупок(1066),
// Логистики(1070): какие поля возвращает (OWNER_ID / STAGE_ID / CREATED_TIME).
//
// Запуск из корня репозитория:
//   node scripts/discover-stagehistory.js
//   node scripts/discover-stagehistory.js "https://ВАШ_ПОРТАЛ.bitrix24.kz/rest/USER/TOKEN/"
try { require('dotenv').config(); } catch (e) {}
if (!process.env.BITRIX_WEBHOOK && process.argv[2]) process.env.BITRIX_WEBHOOK = process.argv[2].trim();
if (!process.env.BITRIX_WEBHOOK) { console.error('❌ BITRIX_WEBHOOK не найден (см. запуск в шапке файла)'); process.exit(1); }
const { b24 } = require('../bitrix');

const P = (...a) => console.log(...a);
const HR = t => P('\n' + '─'.repeat(70) + '\n' + t + '\n' + '─'.repeat(70));

async function probe(entityTypeId, name) {
  HR(`crm.stagehistory.list · ${name} (entityTypeId=${entityTypeId})`);
  try {
    const { result, total, error_description } = await b24('crm.stagehistory.list', {
      entityTypeId, order: { ID: 'DESC' }, start: 0,
    });
    if (error_description) { P('  ⚠', error_description); }
    const items = (result && (result.items || result)) || [];
    P(`  Всего записей истории: ${total != null ? total : '?'}. Показываю первые 6:`);
    (Array.isArray(items) ? items : []).slice(0, 6).forEach(it => {
      P('    ' + JSON.stringify(it));
    });
    // Сгруппируем по OWNER_ID первую попавшуюся сущность — покажем её путь по стадиям.
    const arr = Array.isArray(items) ? items : [];
    const owner = arr.find(x => x.OWNER_ID || x.ownerId);
    if (owner) {
      const oid = owner.OWNER_ID || owner.ownerId;
      const { result: r2 } = await b24('crm.stagehistory.list', {
        entityTypeId, filter: { OWNER_ID: oid }, order: { ID: 'ASC' }, start: 0,
      });
      const seq = (r2 && (r2.items || r2)) || [];
      P(`\n  Путь по стадиям одной сущности OWNER_ID=${oid} (по времени):`);
      (Array.isArray(seq) ? seq : []).forEach(s => {
        const stage = s.STAGE_ID || s.stageId || s.STAGE_SEMANTIC_ID;
        const t = s.CREATED_TIME || s.createdTime || s.DATE_CREATE;
        P(`    ${t}  →  ${stage}`);
      });
    }
  } catch (e) { P('  crm.stagehistory.list error:', e.message); }
}

async function main() {
  await probe(2, 'Сделки');
  await probe(1066, 'Закупки');
  await probe(1070, 'Логистика');
  P('\n✅ Готово. Пришлите весь вывод — по нему сделаю расчёт длительности этапов.');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

// Разведка под модуль «Закуп доп оборудования».
// Запуск в Railway Console:  node scripts/discover-procurement.js
// Печатает: все смарт-процессы (чтобы найти «Подбор доп оборудования» и его
// entityTypeId), категории и стадии смарта «Закупки» (1066) и ПОЛНЫЙ список его
// полей (код → название → тип → обязательность). По этому я точно смэплю UI-форму
// на поля Битрикса. Ничего не меняет — только читает.
const { b24 } = require('../bitrix');

const P = (...a) => console.log(...a);

async function main() {
  // 1) Все смарт-процессы портала
  P('\n═══ СМАРТ-ПРОЦЕССЫ (crm.type.list) ═══');
  try {
    let start = 0;
    while (true) {
      const { result, next } = await b24('crm.type.list', { start });
      (result?.types || []).forEach(t =>
        P(`  entityTypeId=${t.entityTypeId}  «${t.title}»  (id=${t.id}, isCategoriesEnabled=${t.isCategoriesEnabled})`));
      if (next == null) break; start = next;
    }
  } catch (e) { P('  crm.type.list error:', e.message); }

  // 2) Категории смарта «Закупки» (1066)
  P('\n═══ КАТЕГОРИИ 1066 «Закупки» (crm.category.list) ═══');
  const cats = [];
  try {
    const { result } = await b24('crm.category.list', { entityTypeId: 1066 });
    (result?.categories || []).forEach(c => { cats.push(c.id); P(`  categoryId=${c.id}  «${c.name}»`); });
  } catch (e) { P('  crm.category.list error:', e.message); }

  // 3) Стадии по каждой категории 1066
  P('\n═══ СТАДИИ 1066 по категориям ═══');
  for (const cid of cats.length ? cats : [13]) {
    try {
      const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_1066_STAGE_${cid}` }, order: { SORT: 'ASC' } });
      P(`  — категория ${cid}:`);
      (result || []).forEach(s => P(`      ${s.STATUS_ID}  «${s.NAME}»  (SEMANTICS=${s.SEMANTICS || '—'})`));
    } catch (e) { P(`   стадии cat ${cid} error:`, e.message); }
  }

  // 4) Полный список полей 1066
  P('\n═══ ПОЛЯ 1066 (crm.item.fields) ═══');
  try {
    const { result } = await b24('crm.item.fields', { entityTypeId: 1066 });
    const fields = result?.fields || {};
    Object.entries(fields).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).forEach(([code, f]) => {
      const t = f.type + (f.isMultiple ? '[]' : '');
      const req = f.isRequired ? ' REQ' : '';
      P(`  ${code}  «${f.title || ''}»  <${t}>${req}`);
      if (f.type === 'enumeration' && Array.isArray(f.items) && f.items.length)
        P('        значения: ' + f.items.slice(0, 20).map(i => `${i.ID}=${i.VALUE}`).join(' · ') + (f.items.length > 20 ? ' …' : ''));
    });
  } catch (e) { P('  crm.item.fields error:', e.message); }

  // 5) Пара примеров реальных элементов 1066 (чтобы увидеть заполнение и связь со сделкой)
  P('\n═══ ПРИМЕРЫ ЭЛЕМЕНТОВ 1066 (последние 3) ═══');
  try {
    const { result } = await b24('crm.item.list', { entityTypeId: 1066, order: { id: 'DESC' }, start: 0 });
    (result?.items || []).slice(0, 3).forEach(it => {
      P(`  #${it.id} «${(it.title || '').slice(0, 70)}» stage=${it.stageId} parentId2(сделка)=${it.parentId2 || '—'} assignedById=${it.assignedById}`);
    });
  } catch (e) { P('  crm.item.list error:', e.message); }

  P('\nГотово. Скопируй весь вывод сюда — по нему смэплю форму дашборда на поля Битрикса.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

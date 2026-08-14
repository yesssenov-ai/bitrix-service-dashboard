// Разведка под авто-создание закупок из завершённого БП «подбор допов».
// Запуск в Railway Console:  node scripts/discover-service.js
// Печатает категории/стадии и поля смарта «Заявки на сервис» (1058), примеры
// элементов (стадия, родительская сделка, заполненные файловые поля), и поле
// сделки «Требуется подборка доп оборудования». Ничего не меняет — только читает.
const { b24 } = require('../bitrix');
const P = (...a) => console.log(...a);
const T1058 = 1058;

async function main() {
  // Категории 1058
  P('\n═══ КАТЕГОРИИ 1058 «Заявки на сервис» ═══');
  const cats = [];
  try {
    const { result } = await b24('crm.category.list', { entityTypeId: T1058 });
    (result?.categories || []).forEach(c => { cats.push(c.id); P(`  categoryId=${c.id}  «${c.name}»`); });
  } catch (e) { P('  crm.category.list error:', e.message); }

  // Стадии по категориям
  P('\n═══ СТАДИИ 1058 по категориям ═══');
  for (const cid of (cats.length ? cats : [0])) {
    try {
      const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: `DYNAMIC_1058_STAGE_${cid}` }, order: { SORT: 'ASC' } });
      P(`  — категория ${cid}:`);
      (result || []).forEach(s => P(`      ${s.STATUS_ID}  «${s.NAME}»  (SEMANTICS=${s.SEMANTICS || '—'})`));
    } catch (e) { P(`   стадии cat ${cid} error:`, e.message); }
  }

  // Поля 1058 (особенно файловые — под шаблон/финальный файл допов)
  P('\n═══ ПОЛЯ 1058 (crm.item.fields) ═══');
  try {
    const { result } = await b24('crm.item.fields', { entityTypeId: T1058 });
    const fields = result?.fields || {};
    Object.entries(fields).sort((a, b) => String(a[0]).localeCompare(String(b[0]))).forEach(([code, f]) => {
      const t = f.type + (f.isMultiple ? '[]' : '');
      P(`  ${code}  «${f.title || ''}»  <${t}>${f.isRequired ? ' REQ' : ''}`);
    });
    P('\n  → Файловые поля (кандидаты под «финальный файл допов»):');
    Object.entries(fields).filter(([, f]) => f.type === 'file').forEach(([code, f]) => P(`      ${code}  «${f.title || ''}»`));
  } catch (e) { P('  crm.item.fields error:', e.message); }

  // Примеры элементов: стадия, родительская сделка, какие файловые поля заполнены
  P('\n═══ ПРИМЕРЫ ЭЛЕМЕНТОВ 1058 (последние 8) ═══');
  try {
    const ff = await b24('crm.item.fields', { entityTypeId: T1058 });
    const fileCodes = Object.entries(ff.result?.fields || {}).filter(([, f]) => f.type === 'file').map(([c]) => c);
    const { result } = await b24('crm.item.list', { entityTypeId: T1058, order: { id: 'DESC' }, start: 0 });
    (result?.items || []).slice(0, 8).forEach(it => {
      const filled = fileCodes.filter(c => { const v = it[c]; return v && (Array.isArray(v) ? v.length : true); });
      P(`  #${it.id} cat=${it.categoryId} stage=${it.stageId} сделка(parentId2)=${it.parentId2 || '—'} assignedById=${it.assignedById}\n     «${(it.title || '').slice(0, 70)}»  файлы: ${filled.join(', ') || '—'}`);
    });
  } catch (e) { P('  crm.item.list error:', e.message); }

  // Поле сделки «Требуется подборка доп оборудования»
  P('\n═══ ПОЛЕ СДЕЛКИ «Требуется подборка доп оборудования» ═══');
  try {
    const { result } = await b24('crm.deal.fields', {});
    Object.entries(result || {}).forEach(([code, f]) => {
      const title = (f.title || f.formLabel || '').toString();
      if (/подбор|доп.?\s*обор|дополнит/i.test(title)) {
        P(`  ${code}  «${title}»  <${f.type}>`);
        if (Array.isArray(f.items)) P('        значения: ' + f.items.map(i => `${i.ID}=${i.VALUE}`).join(' · '));
      }
    });
  } catch (e) { P('  crm.deal.fields error:', e.message); }

  P('\nГотово. Скопируй вывод сюда. Отметь: какая стадия 1058 = «подбор завершён» и какое файловое поле = финальный файл допов.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

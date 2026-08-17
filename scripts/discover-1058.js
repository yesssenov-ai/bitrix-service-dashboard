// Discovery полей смарт-процесса 1058 (Заявки на сервис) для привязки к карте.
// Запуск в Railway Console:  node discover-1058.js
// Только читает. Находит коды полей «Место проведения работ» и
// «Учёт оборудования клиентов (мнж)», показывает формат и примеры значений.

const { b24 } = require('../bitrix');

const SERVICE_TYPE_FIELD = 'ufCrm8_1744300223'; // Тип оказываемых услуг (УС)
const CLIENT_REQUEST_ID = '619';                // «Заявка клиента» (Tickets)
const isFinalStage = s => /:(SUCCESS|FAIL)$/i.test(String(s || '')) || s === 'DT1058_11:4';
const toArray = v => v == null ? [] : (Array.isArray(v) ? v : [v]);

(async () => {
  // 1) Категории
  const catRes = await b24('crm.category.list', { entityTypeId: 1058 });
  console.log('\n=== КАТЕГОРИИ 1058 ===');
  (catRes.result?.categories || []).forEach(c => console.log(`  cat ${c.id}: ${c.name}`));

  // 2) Все поля 1058 — печатаем код/название/тип; подсвечиваем нужные
  const f = await b24('crm.item.fields', { entityTypeId: 1058 });
  const fields = f.result?.fields || {};
  const RX = /(место|провед|адрес|локац|город|оборудован|учет|учёт|прибор|клиент)/i;
  console.log('\n=== ПОЛЯ-КАНДИДАТЫ (место/адрес/оборудование/учёт) ===');
  const candidates = [];
  for (const [code, meta] of Object.entries(fields)) {
    const title = meta.title || meta.formLabel || '';
    if (RX.test(title) || RX.test(code)) {
      candidates.push(code);
      console.log(`  ${code}  |  «${title}»  |  type=${meta.type}${meta.isMultiple ? ' (множ)' : ''}${meta.settings?.parentEntityTypeId ? ' → binding entityTypeId=' + meta.settings.parentEntityTypeId : ''}`);
    }
  }

  console.log('\n=== ВСЕ ПОЛЯ (код | название | тип) ===');
  for (const [code, meta] of Object.entries(fields)) {
    console.log(`  ${code} | «${meta.title || meta.formLabel || ''}» | ${meta.type}${meta.isMultiple ? ' (множ)' : ''}`);
  }

  // 3) Берём примеры заявок категории Tickets (тип услуг = 619) и печатаем значения кандидатов
  const selCodes = ['id','title','stageId','companyId','categoryId', SERVICE_TYPE_FIELD, ...candidates];
  const all = [];
  let start = 0;
  while (true && all.length < 400) {
    const data = await b24('crm.item.list', {
      entityTypeId: 1058, select: selCodes, order: { id: 'DESC' }, start,
    });
    const batch = data.result?.items || [];
    if (!batch.length) break;
    all.push(...batch);
    const total = data.total ?? (start + batch.length);
    start += batch.length;
    if (!data.next || start >= total) break;
  }
  const active = all.filter(t => !isFinalStage(t.stageId));
  const tickets = active.filter(t => toArray(t[SERVICE_TYPE_FIELD]).map(String).includes(CLIENT_REQUEST_ID));

  console.log(`\n=== ЗАЯВОК получено: ${all.length}, активных: ${active.length}, из них «Заявка клиента»(619): ${tickets.length} ===`);
  console.log('\n=== ПРИМЕРЫ «Заявка клиента» (до 8) — значения полей-кандидатов ===');
  (tickets.length ? tickets : active).slice(0, 8).forEach(t => {
    console.log(`\n  #${t.id} cat=${t.categoryId} company=${t.companyId||'—'} title="${(t.title||'').slice(0,40)}"`);
    candidates.forEach(c => {
      const v = t[c];
      if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length))
        console.log(`      ${c} = ${JSON.stringify(v)}`);
    });
  });

  // 4) Если среди кандидатов есть binding на 1042 — покажем, как выглядит связанный прибор
  console.log('\n=== ГОТОВО. Пришлите этот вывод целиком. ===');
  process.exit(0);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });

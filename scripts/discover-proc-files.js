// Discovery файловых полей смарт-процесса «Закупки» (1066).
// Запуск в Railway Console:  node scripts/discover-proc-files.js
// Только читает. Показывает:
//  1) все файловые поля 1066 (код / название / множественное?) — чтобы точно
//     привязать «Доверенность» и остальные слоты;
//  2) на реальном элементе — структуру файлового объекта (id/name/urlMachine…)
//     и проверку, что байты файла реально скачиваются вебхуком (нужно, чтобы ЦУП
//     мог отдавать файл на почту и на скачивание, не храня его у себя).

const { b24 } = require('../bitrix');
const fetch = require('node-fetch');

const ENTITY = 1066, CATEGORY = 13;
const RX = /(доверенн|сч[её]т.*оплат|подтвержд.*оплат|накладн|гаранти|платеж|оплат)/i;

(async () => {
  // 1) Поля 1066
  const f = await b24('crm.item.fields', { entityTypeId: ENTITY });
  const fields = (f.result && f.result.fields) || {};
  const fileFields = Object.entries(fields).filter(([, m]) => String(m.type).toLowerCase() === 'file');

  console.log(`\n=== ФАЙЛОВЫЕ ПОЛЯ 1066 (${fileFields.length}) ===`);
  for (const [code, m] of fileFields) {
    const mark = RX.test(String(m.title || '')) ? '  <<< кандидат' : '';
    console.log(`  ${code} | «${m.title || ''}» | multiple=${!!m.isMultiple}${mark}`);
  }

  console.log('\n=== ПОЛЕ «ДОВЕРЕННОСТЬ» ===');
  const dov = fileFields.filter(([, m]) => /доверенн/i.test(String(m.title || '')));
  if (dov.length) dov.forEach(([code, m]) => console.log(`  НАЙДЕНО: ${code} | «${m.title}» | multiple=${!!m.isMultiple}`));
  else console.log('  НЕ найдено файлового поля с «Доверенность» в названии — пришлите точное название поля.');

  // 2) Найти элемент 1066 с заполненным файловым полем и разобрать структуру файла
  const codes = fileFields.map(([c]) => c);
  console.log('\n=== ИЩЕМ ЭЛЕМЕНТ С ФАЙЛАМИ ===');
  let sample = null, sampleCode = null;
  let start = 0;
  outer:
  while (start < 400) {
    const r = await b24('crm.item.list', {
      entityTypeId: ENTITY, filter: { categoryId: CATEGORY },
      select: ['id', 'title', ...codes], order: { id: 'DESC' }, start,
    });
    const items = (r.result && r.result.items) || [];
    if (!items.length) break;
    for (const it of items) {
      for (const c of codes) {
        const v = it[c];
        const arr = Array.isArray(v) ? v : (v ? [v] : []);
        if (arr.length && arr[0] && typeof arr[0] === 'object') { sample = { itemId: it.id, file: arr[0], count: arr.length }; sampleCode = c; break outer; }
      }
    }
    start += items.length;
    if (!r.result.next) break;
  }

  if (!sample) { console.log('  Не нашли ни одного элемента с приложенным файлом (создайте тестовый и запустите снова).'); process.exit(0); }

  console.log(`  Элемент #${sample.itemId}, поле ${sampleCode} («${(fields[sampleCode] || {}).title || ''}»), файлов в поле: ${sample.count}`);
  console.log('  Ключи файлового объекта:', Object.keys(sample.file).join(', '));
  const pick = k => sample.file[k];
  console.log('    id          =', pick('id') ?? pick('ID'));
  console.log('    name        =', pick('name') ?? pick('NAME') ?? pick('originalName'));
  console.log('    urlMachine  =', pick('urlMachine') || pick('downloadUrl') || pick('url') || '(нет)');

  // 3) Проверка: скачивается ли файл вебхуком (это критично для писем и скачивания из ЦУП)
  const url = pick('urlMachine') || pick('downloadUrl') || pick('url');
  if (url) {
    console.log('\n=== ПРОВЕРКА СКАЧИВАНИЯ (urlMachine) ===');
    for (const variant of [url, url + (url.includes('?') ? '&' : '?') + 'auth=' + (process.env.BITRIX_WEBHOOK || '').split('/').filter(Boolean).pop()]) {
      try {
        const res = await fetch(variant, { redirect: 'follow' });
        const buf = await res.buffer();
        console.log(`  ${res.status} · ${res.headers.get('content-type') || '?'} · ${buf.length} байт  ← ${variant.slice(0, 90)}`);
        if (res.ok && buf.length > 0) { console.log('  ✅ Файл скачивается — ЦУП сможет отдавать его на почту и на скачивание.'); break; }
      } catch (e) { console.log('  ошибка:', e.message); }
    }
  }

  console.log('\n=== ГОТОВО. Пришлите весь вывод. ===');
  process.exit(0);
})().catch(e => { console.error('ОШИБКА:', e.message); process.exit(1); });

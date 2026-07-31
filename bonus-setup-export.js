// Run in Railway Console: node bonus-setup-export.js <kuanysh.e@prolabsupport.kz>
// Produces:
//   1. Console output — full field list for smart process 1046 (Отчёт)
//   2. Console output — search for "Источник" fields within 1058, to confirm the field code
//   3. Emails you the full instrument list (ufCrmPribor) as an .xlsx attachment
//      with empty columns for you to fill in category + tariff amounts —
//      saving to the container's disk isn't useful since it's ephemeral and
//      not downloadable from the console.

const XLSX = require('xlsx');
const fetch = require('node-fetch');
const { b24 } = require('./bitrix');

const RESEND_KEY = process.env.RESEND_API_KEY;

async function main() {
  const recipient = process.argv[2];
  if (!recipient) { console.error('Usage: node bonus-setup-export.js <your-email>'); process.exit(1); }

  console.log('\n=== 1) Поля смарт-процесса 1046 (Отчёт) ===\n');
  try {
    const { result: r1046 } = await b24('crm.item.fields', { entityTypeId: 1046 });
    const fields1046 = r1046?.fields || {};
    Object.entries(fields1046).forEach(([code, meta]) => {
      console.log(`${code.padEnd(30)} | ${meta.title || ''} | type=${meta.type}`);
    });
  } catch (e) {
    console.error('Ошибка получения полей 1046:', e.message);
  }

  console.log('\n=== 2) Поиск поля "Источник" среди полей 1058 ===\n');
  try {
    const { result: r1058 } = await b24('crm.item.fields', { entityTypeId: 1058 });
    const fields1058 = r1058?.fields || {};
    Object.entries(fields1058).forEach(([code, meta]) => {
      const title = (meta.title || '').toLowerCase();
      if (title.includes('источник')) {
        console.log(`НАЙДЕНО: ${code} | ${meta.title} | type=${meta.type}`);
        if (meta.items) {
          console.log('  Варианты значений:');
          meta.items.forEach(i => console.log(`    ${i.ID} = ${i.VALUE}`));
        }
      }
    });
  } catch (e) {
    console.error('Ошибка получения полей 1058:', e.message);
  }

  console.log('\n=== 3) Выгрузка списка приборов (ufCrmPribor) — отправка на почту ===\n');
  try {
    const { result } = await b24('crm.item.fields', { entityTypeId: 1058 });
    const items = result?.fields?.ufCrmPribor?.items || [];
    console.log(`Найдено приборов: ${items.length}`);

    const rows = [['ID (не менять)', 'Название прибора', 'Категория тарифа', 'Установка+обучение USD', 'Методическое обучение USD']];
    items.forEach(i => rows.push([i.ID, i.VALUE, '', '', '']));

    const wsInstruments = XLSX.utils.aoa_to_sheet(rows);
    wsInstruments['!cols'] = [{ wch: 10 }, { wch: 50 }, { wch: 20 }, { wch: 20 }, { wch: 20 }];

    const tariffRef = [
      ['Категория', 'Установка+обучение USD', 'Методическое обучение USD'],
      ['UV-VIS', 150, 300], ['FLR', 150, 300], ['IR-F', 150, 500], ['RS', 300, 700], ['LDIR', 300, 700],
      ['AAS', 250, 750], ['MP-AES', 250, 750], ['ICP-OES', 250, 1250], ['ICP-MS', 500, 2000],
      ['GC', 250, 750], ['GC-MS', 300, 1200], ['GC-QTOF', 500, 1000],
      ['HPLC', 250, 750], ['HPLC-MS', 300, 1200], ['HPLC-QTOF', 500, 1000], ['CE', 250, 500],
      ['Epsilon EXRF', 250, 750], ['Zetium EXRF', 500, 2000], ['WXRF', 250, 650], ['Aeris XRD', 250, 1250],
      ['LDPA', 200, 400], ['IA', 200, 400], ['DDL', 300, 500], ['NaPA', 300, 500],
    ];
    const wsTariffs = XLSX.utils.aoa_to_sheet(tariffRef);
    wsTariffs['!cols'] = [{ wch: 15 }, { wch: 24 }, { wch: 24 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, wsInstruments, 'Приборы');
    XLSX.utils.book_append_sheet(wb, wsTariffs, 'Категории (справочно)');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    if (!RESEND_KEY) { console.error('RESEND_API_KEY не настроен — не могу отправить письмо.'); return; }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ProLabSupport ЦУП <noreply@prolabsupport.kz>',
        to: [kuanysh.e@prolabsupport.kz],
        subject: 'Выгрузка приборов для настройки бонусов',
        html: '<p>Во вложении — полный список приборов из Bitrix. Заполни колонку "Категория тарифа" (можно свериться со справочным листом), пришли обратно.</p>',
        attachments: [{ filename: 'instruments-export.xlsx', content: buffer.toString('base64') }],
      }),
    });
    if (!res.ok) console.error('Ошибка отправки письма:', await res.text());
    else console.log(`✅ Письмо с файлом отправлено на ${recipient}`);
  } catch (e) {
    console.error('Ошибка выгрузки приборов:', e.message);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

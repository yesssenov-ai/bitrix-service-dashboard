// probe-smart.js <dealId> — discover the field codes on the «Закупки» (1066) and
// «Заявка на сервис» (1058) smart processes, and dump the raw values on a real
// deal's children, so we can source: Инженер (1058), Оплата клиент/завод +
// Дата отгрузки от завода (1066).
//
// Run on a deal that HAS both a Закупка and a Заявка на сервис:
//   node probe-smart.js 105227
const { b24 } = require('./bitrix');
const { findChildrenOfDeal } = require('./relations');

async function call(m, p) { try { return await b24(m, p || {}); } catch (e) { return { __error: e.message }; } }

function dumpFields(title, fieldsObj, re) {
  console.log('\n' + '='.repeat(80) + '\n' + title + '\n' + '='.repeat(80));
  const entries = Object.entries(fieldsObj || {});
  console.log('всего полей:', entries.length);
  entries.forEach(([code, f]) => {
    const label = f.title || f.formLabel || f.listLabel || '';
    if (!re || re.test(label) || re.test(code)) {
      console.log(`  ${code.padEnd(26)} ${((f.type || '') + (f.isMultiple ? '[]' : '')).padEnd(16)} ${label}`);
    }
  });
}

async function main() {
  const dealId = parseInt(process.argv[2] || '0', 10);

  const f1066 = await call('crm.item.fields', { entityTypeId: 1066 });
  dumpFields('Закупки (1066) — поля оплаты / отгрузки', f1066.result?.fields || f1066.result, /оплат|отгруз|поставщик|клиент|срок|дата|услов/i);

  const f1058 = await call('crm.item.fields', { entityTypeId: 1058 });
  dumpFields('Заявка на сервис (1058) — поля инженера', f1058.result?.fields || f1058.result, /инженер|ответствен|engineer|исполнител/i);

  if (dealId) {
    const kids = await findChildrenOfDeal(dealId);
    console.log('\n' + '='.repeat(80) + `\nДети сделки #${dealId}\n` + '='.repeat(80));
    kids.forEach(k => console.log(`  тип ${k.entityTypeId}  #${k.id}  ${k.title || ''}  (${k.stageId})`));
    for (const et of [1066, 1058]) {
      const child = kids.find(k => Number(k.entityTypeId) === et);
      if (!child) { console.log(`\n(нет ребёнка типа ${et} у этой сделки — возьми другую)`); continue; }
      const it = await call('crm.item.get', { entityTypeId: et, id: child.id });
      const item = it.result?.item || {};
      console.log(`\n=== Непустые ufCrm-поля ${et} #${child.id} ===`);
      Object.entries(item).forEach(([k, v]) => {
        if (/^ufCrm/i.test(k) && v != null && v !== '' && !(Array.isArray(v) && !v.length)) console.log(`  ${k} = ${JSON.stringify(v)}`);
      });
    }
  } else {
    console.log('\n(добавь id сделки: node probe-smart.js <dealId> — покажу сырые значения на её Закупке и Заявке)');
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

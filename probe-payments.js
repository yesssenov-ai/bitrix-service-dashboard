// probe-payments.js <dealId> — dump one deal's RAW payment / manager / engineer
// values, and resolve the client-payment iblock reference, so we can finalize
// those columns without guessing.
//
// Run on a deal where BOTH payment terms are visible in the Bitrix card:
//   node probe-payments.js 357
//
// Needs at least crm scope (works already). The client-iblock element listing
// additionally needs the «lists» scope on the webhook — if it 401s, that's the
// signal to enable it (or just read the ~4 values off the Bitrix card manually).

const { b24 } = require('./bitrix');

const FIELDS = {
  ASSIGNED_BY_ID:       'Менеджер (user id)',
  UF_CRM_1744195326183: 'Оплата завод (enum)',
  UF_CRM_1731864478:    'Оплата клиент (iblock_element)',
  UF_CRM_1761294746543: 'Оплата клиент (строка, альт.)',
  UF_CRM_1731864788:    'Инженер (employee)',
  UF_CRM_1734607330937: 'Поставка по договору',
  UF_CRM_1731864831522: 'Отгрузка от завода',
  STAGE_ID:             'Стадия',
  COMPANY_ID:           'Компания id',
};

async function call(m, p) { try { return await b24(m, p || {}); } catch (e) { return { __error: e.message }; } }

async function main() {
  const dealId = parseInt(process.argv[2] || '357', 10);

  const dg = await call('crm.deal.get', { id: dealId });
  const deal = dg.result;
  console.log(`=== Сделка #${dealId}: ${deal?.TITLE || '(не найдена)'} ===`);
  if (dg.__error) console.log('  ошибка:', dg.__error);
  for (const [code, label] of Object.entries(FIELDS)) {
    console.log(`  ${label.padEnd(34)} ${code} = ${JSON.stringify(deal?.[code])}`);
  }

  // Client-payment field settings → which iblock its values live in.
  console.log('\n=== Настройки поля «Оплата клиент» (UF_CRM_1731864478) ===');
  const ufs = await call('crm.deal.userfield.list', { filter: { FIELD_NAME: 'UF_CRM_1731864478' } });
  const uf = (ufs.result || [])[0];
  console.log(JSON.stringify(uf?.SETTINGS || uf || ufs, null, 2));

  const iblockId = (uf?.SETTINGS || {}).IBLOCK_ID || 21;
  console.log(`\n=== Подбор типа списка для IBLOCK_ID=${iblockId} (lists.get) ===`);
  let typeId = null;
  for (const t of ['lists', 'bitrix_processes', 'bitrix_catalog']) {
    const lg = await call('lists.get', { IBLOCK_TYPE_ID: t });
    if (lg.__error) { console.log(`  lists.get(${t}) → ошибка: ${lg.__error}`); continue; }
    const found = (lg.result || []).find(l => String(l.IBLOCK_ID) === String(iblockId));
    console.log(`  lists.get(${t}) → списков: ${(lg.result || []).length}${found ? `  ← НАЙДЕН (name="${found.NAME}")` : ''}`);
    if (found) { typeId = t; break; }
  }
  if (typeId) {
    console.log(`\n=== Значения справочника «Оплата клиент» (type=${typeId}, IBLOCK_ID=${iblockId}) ===`);
    const els = await call('lists.element.get', { IBLOCK_TYPE_ID: typeId, IBLOCK_ID: iblockId });
    if (els.__error) console.log('  ошибка:', els.__error);
    else {
      (els.result || []).forEach(e => console.log(`  ${e.ID} = ${e.NAME}`));
      if (!(els.result || []).length) console.log('  (пусто)');
    }
  } else {
    console.log(`\nНе нашёл список с IBLOCK_ID=${iblockId}. Пришли 4 значения оплаты клиента с их id из карточки сделки вручную — захардкожу.`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

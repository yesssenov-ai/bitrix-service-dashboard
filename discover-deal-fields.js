// Discovery helper for the Operational (Реализация) module.
// Dumps every deal field (code | type | label) so we can map the detail-table
// columns (Поставка по договору, Отгрузка от завода, Условия оплаты завод/клиент,
// Инженер, Комментарий) to their real UF_CRM_* codes.
//
// Run locally (needs BITRIX_WEBHOOK in env, same as the rest of the app):
//   node discover-deal-fields.js                 — dump ALL deal fields + highlight likely matches
//   node discover-deal-fields.js sample 0        — also print a real deal from pipeline 0 in an execution stage
//   node discover-deal-fields.js items UF_CRM_XXX — list the choices of one enum/list field
//
// Paste the output back into the chat and I'll wire the exact codes into operational.js.

const { b24 } = require('./bitrix');

// Keywords → which column each likely belongs to. Purely to help eyeball the dump.
const HINTS = [
  { col: 'Поставка по договору (дата)', re: /поставк|срок.*постав|договор.*дат|плагов|плановая дата/i },
  { col: 'Отгрузка от завода (дата)',   re: /отгруз|завод|shipment|ship|отправк/i },
  { col: 'Условие оплаты (завод)',      re: /оплат.*завод|услов.*завод|payment.*fact|завод.*оплат/i },
  { col: 'Условие оплаты (клиент)',     re: /оплат.*клиент|услов.*оплат|payment.*client|клиент.*оплат/i },
  { col: 'Инженер',                     re: /инженер|engineer|исполнител/i },
  { col: '№ Договора / контракт',       re: /договор|контракт|contract|№/i },
  { col: 'Комментарий',                 re: /коммент|примечан|comment|note/i },
  { col: 'Дата договора (подписание)',  re: /дата.*договор|подписан|contract.*date/i },
  { col: 'Конечный пользователь',       re: /конечн|пользовател|end.?user|грузополуч|заказчик|потребител/i },
];

function typeOf(f) {
  return `${f.type}${f.isMultiple ? '[]' : ''}`;
}

async function dumpAllFields() {
  const { result } = await b24('crm.deal.fields', {});
  const fields = result || {};
  const entries = Object.entries(fields);

  console.log(`Всего полей сделки: ${entries.length}\n`);
  console.log('='.repeat(90));
  console.log('ВСЕ ПОЛЯ  (код | тип | название)');
  console.log('='.repeat(90));
  entries
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([code, f]) => {
      const label = f.formLabel || f.title || f.listLabel || '';
      console.log(`${code.padEnd(30)} ${typeOf(f).padEnd(16)} ${label}`);
    });

  console.log('\n' + '='.repeat(90));
  console.log('ВЕРОЯТНЫЕ СОВПАДЕНИЯ по колонкам таблицы «Реализация»');
  console.log('='.repeat(90));
  for (const hint of HINTS) {
    const matches = entries.filter(([code, f]) => {
      const label = `${f.formLabel || ''} ${f.title || ''} ${f.listLabel || ''}`;
      return hint.re.test(label) || hint.re.test(code);
    });
    console.log(`\n▸ ${hint.col}`);
    if (!matches.length) { console.log('    (кандидатов не найдено)'); continue; }
    matches.forEach(([code, f]) => {
      const label = f.formLabel || f.title || f.listLabel || '';
      console.log(`    ${code.padEnd(28)} ${typeOf(f).padEnd(14)} ${label}`);
    });
  }
}

async function sampleDeal(categoryId) {
  // Grab a couple of deals in this pipeline to see which fields are actually filled.
  const { result } = await b24('crm.deal.list', {
    filter: { CATEGORY_ID: String(categoryId) },
    select: ['*', 'UF_*'],
    order: { DATE_MODIFY: 'DESC' },
  });
  const deals = (result || []).slice(0, 3);
  console.log(`\nПримеры сделок из воронки ${categoryId} (${deals.length}):\n`);
  deals.forEach(d => {
    console.log(`${'='.repeat(20)} #${d.ID} — ${d.TITLE} (STAGE ${d.STAGE_ID}) ${'='.repeat(20)}`);
    Object.entries(d).forEach(([code, value]) => {
      if (value === null || value === '' || value === undefined) return;
      if (Array.isArray(value) && !value.length) return;
      console.log(`  ${code.padEnd(28)} = ${JSON.stringify(value)}`);
    });
    console.log();
  });
}

async function listItems(fieldCode) {
  const { result } = await b24('crm.deal.fields', {});
  const field = result?.[fieldCode];
  if (!field) { console.log(`Поле ${fieldCode} не найдено`); return; }
  console.log(`Поле ${fieldCode} — type=${field.type}, isMultiple=${field.isMultiple}, label="${field.formLabel || field.title || ''}"\n`);
  (field.items || []).forEach(i => console.log(`  ${JSON.stringify(i)}`));
  if (!field.items) console.log('(нет списка значений — не enum/iblock-поле)');
}

async function main() {
  const [, , mode, arg] = process.argv;
  if (mode === 'sample') { await sampleDeal(arg || 0); return; }
  if (mode === 'items')  { await listItems(arg); return; }
  await dumpAllFields();
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

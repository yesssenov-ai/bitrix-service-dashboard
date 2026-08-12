// Проверка: резолвится ли поле «Производитель» через API (ID значения → имя бренда).
// Если да — робот в Битриксе не нужен, чиним только код.
//
// ЗАПУСК: положи в scripts/, задеплой, потом в Railway Console:
//   node scripts/probe-manufacturer.js
// (нужен только BITRIX_WEBHOOK в окружении; БД не трогает)

const { b24 } = require('../bitrix');

const MANUF_CODE = 'UF_CRM_1731862648';     // Производитель (по памяти)
const INSTR_CODE = 'UF_CRM_NAME_PRIOBOR';   // Название прибора

const lbl = f => {
  const v = f.EDIT_FORM_LABEL || f.LIST_COLUMN_LABEL || f.FIELD_NAME;
  return typeof v === 'object' ? (v.ru || v.en || Object.values(v)[0] || '') : v;
};

async function main() {
  // 1) Все пользовательские поля сделок — находим «Производитель» и «Название прибора»
  const resp = await b24('crm.deal.userfield.list', {});
  const fields = resp.result || [];
  console.log(`Всего пользовательских полей сделок: ${fields.length}`);

  const byCode = code => fields.find(f => f.FIELD_NAME === code);
  const byLabel = re => fields.filter(f => re.test(lbl(f)) || re.test(f.FIELD_NAME));

  console.log('\n=== Кандидаты по слову «Произв» ===');
  for (const f of byLabel(/произв/i)) console.log(`  ${f.FIELD_NAME}  тип=${f.USER_TYPE_ID}  «${lbl(f)}»  значений в списке: ${(f.LIST || []).length}`);

  const manuf = byCode(MANUF_CODE) || byLabel(/произв/i)[0];
  if (!manuf) { console.log('\n❌ Поле «Производитель» не найдено — проверь код'); return; }

  console.log(`\n=== Поле производителя: ${manuf.FIELD_NAME} ===`);
  console.log(`тип (USER_TYPE_ID): ${manuf.USER_TYPE_ID}`);
  const list = manuf.LIST || [];
  console.log(`значений в справочнике (LIST): ${list.length}`);
  if (list.length) {
    console.log('первые значения (ID → имя):');
    list.slice(0, 45).forEach(it => console.log(`   ${it.ID}  →  ${it.VALUE}`));
  } else {
    console.log('⚠️  LIST пустой — это НЕ обычное перечисление, значит через API имя не достать (нужен робот).');
  }
  const id2name = Object.fromEntries(list.map(it => [String(it.ID), it.VALUE]));

  // 2) Сырые значения на реальных сделках + попытка резолва
  const deals = (await b24('crm.deal.list', {
    filter: { [`!${manuf.FIELD_NAME}`]: '', '@CATEGORY_ID': ['0', '1', '2', '3'] },
    select: ['ID', 'TITLE', manuf.FIELD_NAME, INSTR_CODE],
    order: { ID: 'DESC' },
  })).result || [];

  console.log(`\n=== Сырые значения на ${Math.min(deals.length, 20)} последних сделках ===`);
  let hit = 0, total = 0;
  for (const d of deals.slice(0, 20)) {
    const raw = d[manuf.FIELD_NAME];
    const rawArr = Array.isArray(raw) ? raw : [raw];
    total++;
    const resolved = rawArr.map(v => id2name[String(v)] || `?(${v})`).join(', ');
    if (rawArr.every(v => id2name[String(v)])) hit++;
    console.log(`  #${d.ID}  сырое=${JSON.stringify(raw)}  → ${resolved}   [прибор: ${d[INSTR_CODE] || '—'}]`);
  }

  console.log(`\n=== ИТОГ ===`);
  if (list.length && total && hit === total) {
    console.log(`✅ РЕЗОЛВИТСЯ: ${hit}/${total}. Значения — это ID из LIST, имя достаётся напрямую. Робот НЕ нужен — правим только код.`);
  } else if (list.length && hit > 0) {
    console.log(`⚠️  ЧАСТИЧНО: ${hit}/${total} резолвится через LIST, остальное — нет. Пришли вывод, разберёмся.`);
  } else {
    console.log(`❌ НЕ РЕЗОЛВИТСЯ через API: сырые значения не совпадают с ID из справочника. Идём роботом, как договаривались.`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('Ошибка:', e.message); process.exit(1); });

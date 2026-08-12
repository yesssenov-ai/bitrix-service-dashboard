// Проверка v4: среди полей-инфоблоков брендов нет → «Производитель» это обычное
// поле-СПИСОК (enumeration). Сканируем ВСЕ поля сделок и ищем то, в чьём списке
// значений есть Agilent/Metrohm/… Карта ID→бренд придёт прямо из userfield.list.
//
// ЗАПУСК (нужен BITRIX_WEBHOOK): node scripts/probe-manufacturer.js
const { b24 } = require('../bitrix');
const INSTR_CODE = 'UF_CRM_NAME_PRIOBOR';
const BRANDS = /agilent|metrohm|malvern|waters|sartorius|mettler|\bleco\b|struers|olympus|sciaps|labtech|biobase|peak scientific|elga|powteq|belaquilon/i;

async function call(m, p) { try { return await b24(m, p || {}); } catch (e) { return { __error: e.message }; } }
const lbl = f => { const v = f.EDIT_FORM_LABEL || f.LIST_COLUMN_LABEL || f.FIELD_NAME; return typeof v === 'object' ? (v.ru || v.en || Object.values(v)[0] || '') : v; };

async function main() {
  const fields = (await call('crm.deal.userfield.list', {})).result || [];
  const enums = fields.filter(f => Array.isArray(f.LIST) && f.LIST.length);
  console.log(`Полей-списков (enumeration) на сделках: ${enums.length}`);

  // ищем поле, где в значениях есть бренды
  const hits = enums.filter(f => (f.LIST || []).some(it => BRANDS.test(it.VALUE || '')));
  if (!hits.length) {
    console.log('\n❌ Не нашёл список с брендами. Ниже — все поля-списки (код, метка, первые значения), поищем глазами:');
    for (const f of enums) console.log(`  ${f.FIELD_NAME}  «${lbl(f)}»: ${(f.LIST || []).slice(0, 5).map(x => x.VALUE).join(', ')}…`);
    return;
  }

  for (const manuf of hits) {
    const CODE = manuf.FIELD_NAME;
    console.log(`\n=== НАЙДЕНО поле производителя: ${CODE}  «${lbl(manuf)}»  (значений: ${manuf.LIST.length}) ===`);
    const id2name = {};
    manuf.LIST.forEach(it => { id2name[String(it.ID)] = it.VALUE; console.log(`   ${it.ID}  →  ${it.VALUE}`); });

    const deals = (await call('crm.deal.list', { filter: { [`!${CODE}`]: '', '@CATEGORY_ID': ['0', '1', '2', '3'] }, select: ['ID', CODE, INSTR_CODE], order: { ID: 'DESC' } })).result || [];
    console.log(`\n--- Сырые значения (20 сделок) ---`);
    let hit = 0, tot = 0;
    for (const d of deals.slice(0, 20)) { const raw = d[CODE]; tot++; const nm = id2name[String(raw)]; if (nm) hit++; console.log(`  #${d.ID}  ID=${raw} → ${nm || '?'}   [прибор: ${d[INSTR_CODE] || '—'}]`); }
    console.log(hit === tot && tot ? `\n✅ ГОТОВО по ${CODE}: резолв ${hit}/${tot}. Пришли мне код поля + полный список ID→бренд. Захардкожу и правлю stats-sync.js — без робота.` : `\n⚠️ ${CODE}: резолв ${hit}/${tot}, пришли вывод.`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error('Ошибка:', e.message); process.exit(1); });

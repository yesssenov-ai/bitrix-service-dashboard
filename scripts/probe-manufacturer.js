// Проверка v3: UF_CRM_1731862648 оказался РЕГИОНОМ (инфоблок 17 = география).
// Ищем НАСТОЯЩЕЕ поле «Производитель»: перебираем все поля-инфоблоки сделок и
// находим тот справочник, где есть Agilent/Metrohm/… Затем строим карту ID→бренд.
//
// ЗАПУСК (нужен BITRIX_WEBHOOK): node scripts/probe-manufacturer.js
const { b24 } = require('../bitrix');
const INSTR_CODE = 'UF_CRM_NAME_PRIOBOR';
const BRANDS = /agilent|metrohm|malvern|waters|sartorius|mettler|leco|struers|olympus|sciaps|labtech|biobase|peak scientific|elga/i;

async function call(m, p) { try { return await b24(m, p || {}); } catch (e) { return { __error: e.message }; } }
const lbl = f => { const v = f.EDIT_FORM_LABEL || f.LIST_COLUMN_LABEL || f.FIELD_NAME; return typeof v === 'object' ? (v.ru || v.en || Object.values(v)[0] || '') : v; };

async function readIblock(iblockId) {
  for (const t of ['lists', 'bitrix_processes', 'lists_socnet']) {
    const r = await call('lists.element.get', { IBLOCK_TYPE_ID: t, IBLOCK_ID: iblockId, ELEMENT_ORDER: { ID: 'ASC' } });
    if (!r.__error && Array.isArray(r.result) && r.result.length) return { type: t, els: r.result };
  }
  return null;
}

async function main() {
  const fields = (await call('crm.deal.userfield.list', {})).result || [];
  const iblockFields = fields.filter(f => f.USER_TYPE_ID === 'iblock_element');
  console.log(`Поля-инфоблоки (iblock_element) на сделках: ${iblockFields.length}`);
  for (const f of iblockFields) console.log(`  ${f.FIELD_NAME}  IBLOCK_ID=${f.SETTINGS?.IBLOCK_ID}  «${lbl(f)}»`);

  // читаем каждый уникальный инфоблок, ищем тот, где есть бренды
  const seen = new Map(); // iblockId -> {type, els}
  let manufField = null, manufBlock = null;
  console.log('\n=== Содержимое справочников ===');
  for (const f of iblockFields) {
    const ib = f.SETTINGS?.IBLOCK_ID; if (!ib || seen.has(ib)) { if (seen.get(ib) && !manufField && seen.get(ib).isBrand) { manufField = f; manufBlock = seen.get(ib); } continue; }
    const data = await readIblock(ib);
    if (!data) { console.log(`  IBLOCK ${ib} (${lbl(f)}) — через lists.* не читается`); seen.set(ib, null); continue; }
    const names = data.els.map(e => e.NAME || e.name);
    const isBrand = names.some(n => BRANDS.test(n || ''));
    seen.set(ib, { ...data, isBrand });
    console.log(`  IBLOCK ${ib} (${lbl(f)}) — ${data.els.length} элементов${isBrand ? '  ★ ПОХОЖЕ НА ПРОИЗВОДИТЕЛЕЙ' : ''}: ${names.slice(0, 6).join(', ')}…`);
    if (isBrand && !manufField) { manufField = f; manufBlock = seen.get(ib); }
  }

  if (!manufField) { console.log('\n❌ Не нашёл справочник с брендами среди полей-инфоблоков. Пришли этот вывод — посмотрим по названиям полей.'); return; }

  const CODE = manufField.FIELD_NAME;
  console.log(`\n=== НАЙДЕНО поле производителя: ${CODE}  (IBLOCK ${manufField.SETTINGS.IBLOCK_ID}, «${lbl(manufField)}») ===`);
  const id2name = {};
  manufBlock.els.forEach(e => { id2name[String(e.ID)] = e.NAME; console.log(`   ${e.ID}  →  ${e.NAME}`); });

  const deals = (await call('crm.deal.list', { filter: { [`!${CODE}`]: '', '@CATEGORY_ID': ['0', '1', '2', '3'] }, select: ['ID', CODE, INSTR_CODE], order: { ID: 'DESC' } })).result || [];
  console.log(`\n=== Сырые значения (20 сделок) ===`);
  let hit = 0, tot = 0;
  for (const d of deals.slice(0, 20)) { const raw = d[CODE]; tot++; const nm = id2name[String(raw)]; if (nm) hit++; console.log(`  #${d.ID}  ID=${raw} → ${nm || '?'}   [прибор: ${d[INSTR_CODE] || '—'}]`); }

  console.log('\n=== ИТОГ ===');
  console.log(hit === tot && tot ? `✅ ГОТОВО: поле ${CODE}, справочник читается, резолв ${hit}/${tot}. Пришли мне: (1) этот код поля, (2) полный список ID→бренд выше. Захардкожу карту и правлю stats-sync.js — без робота.` : `⚠️ резолв ${hit}/${tot}, пришли вывод.`);
}
main().then(() => process.exit(0)).catch(e => { console.error('Ошибка:', e.message); process.exit(1); });

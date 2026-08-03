// Run in Railway Console: node stats-discovery.js
// Prints:
//   1. Full field list for Сделки (crm.deal.fields) — to find "Дата договора"
//      and the instrument/model text field
//   2. Full field list for Компании (crm.company.fields) — to find "Сфера деятельности"
//   3. The real WON-stage(s) for each of our 4 known sales pipelines, straight
//      from Bitrix's own dealcategory.stage.list — not the hardcoded guess
//      already in relations.js, which turned out to be stale (a real deal
//      was seen in stage C3:WON, which isn't in that list at all)

const { b24call, SALES_CATEGORIES } = require('./relations');

async function main() {
  console.log('\n=== 1) Поля сделок (crm.deal.fields) ===\n');
  try {
    const { result } = await b24call('crm.deal.fields', {});
    Object.entries(result || {}).forEach(([code, meta]) => {
      console.log(`${code.padEnd(28)} | ${meta.title || meta.formLabel || ''} | type=${meta.type}`);
    });
  } catch (e) {
    console.error('Ошибка получения полей сделки:', e.message);
  }

  console.log('\n=== 2) Поля компаний (crm.company.fields) ===\n');
  try {
    const { result } = await b24call('crm.company.fields', {});
    Object.entries(result || {}).forEach(([code, meta]) => {
      console.log(`${code.padEnd(28)} | ${meta.title || meta.formLabel || ''} | type=${meta.type}`);
    });
  } catch (e) {
    console.error('Ошибка получения полей компании:', e.message);
  }

  console.log('\n=== 3) Реальные стадии (WON) по каждой из 4 воронок ===\n');
  for (const [categoryId, cfg] of Object.entries(SALES_CATEGORIES)) {
    console.log(`--- Категория ${categoryId}: ${cfg.name} ---`);
    try {
      const { result } = await b24call('crm.dealcategory.stage.list', { id: categoryId });
      (result || []).forEach(s => console.log(`  ${s.STATUS_ID.padEnd(20)} | ${s.NAME} | SEMANTICS=${s.SEMANTICS || '?'}`));
    } catch (e) {
      console.error(`  Ошибка получения стадий для категории ${categoryId}:`, e.message);
    }
    // Fallback/cross-check: crm.status.list with the standard DEAL_STAGE entity_id
    // pattern, which is where SEMANTICS (S=success/F=fail/P=process) actually lives.
    try {
      const entityId = categoryId === '0' ? 'DEAL_STAGE' : `DEAL_STAGE_${categoryId}`;
      const { result } = await b24call('crm.status.list', { filter: { ENTITY_ID: entityId } });
      console.log(`  (crm.status.list ${entityId}):`);
      (result || []).forEach(s => console.log(`    ${s.STATUS_ID.padEnd(20)} | ${s.NAME} | SEMANTICS=${s.SEMANTICS || '?'}`));
    } catch (e) {
      console.error(`  Ошибка crm.status.list для ${categoryId}:`, e.message);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

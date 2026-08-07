// discover-bizproc.js — probe what Bitrix exposes about automation business
// processes (бизнес-процессы / БП, e.g. «Шаблон автоматизации», «Проверить
// товар…») so we know how to pull them into the operational dashboard.
//
// Run locally (needs BITRIX_WEBHOOK in env):
//   node discover-bizproc.js                 — list BP templates (name + entity/document type)
//   node discover-bizproc.js instances       — list currently RUNNING BP instances
//   node discover-bizproc.js deal 357        — walk a deal's smart children and show running BPs per item
//
// Paste the output back so we can wire the right pull. NB: standard Bitrix REST
// (bizproc.workflow.instances) returns only RUNNING instances — completed ones
// usually drop off; this script confirms exactly what YOUR portal exposes.

const { b24 } = require('./bitrix');

async function call(method, params) {
  try { return await b24(method, params || {}); }
  catch (e) { return { __error: e.message }; }
}

function show(title, obj) {
  console.log('\n' + '='.repeat(80) + '\n' + title + '\n' + '='.repeat(80));
  console.log(JSON.stringify(obj, null, 2));
}

async function templates() {
  const r = await call('bizproc.workflow.template.list', {
    select: ['ID', 'MODULE_ID', 'ENTITY', 'DOCUMENT_TYPE', 'NAME', 'AUTO_EXECUTE'],
  });
  show('bizproc.workflow.template.list — шаблоны БП (имя + к какому типу документа привязан)', r);
  if (r.__error) console.log('\n⚠️  Если ошибка про scope/method — в вебхуке нет права «bizproc». Добавь доступ к бизнес-процессам в настройках вебхука Bitrix и повтори.');
}

async function instances() {
  const r = await call('bizproc.workflow.instances', {
    select: ['ID', 'MODULE_ID', 'ENTITY', 'DOCUMENT_ID', 'TEMPLATE_ID', 'STARTED', 'STARTED_BY', 'MODIFIED', 'OWNED_UNTIL'],
  });
  show('bizproc.workflow.instances — АКТИВНЫЕ (running) экземпляры БП', r);
  const items = r.result || r.instances || [];
  if (Array.isArray(items)) console.log(`\nВсего активных экземпляров: ${items.length}`);
}

// Reuse the app's own child-finder so we probe the exact smart items a deal has.
async function dealWalk(dealId) {
  const { findChildrenOfDeal } = require('./relations');
  const children = await findChildrenOfDeal(dealId);
  console.log(`\nДочерние смарт-процессы сделки #${dealId}: ${children.length}`);
  // All running instances once, then match by DOCUMENT_ID.
  const inst = await call('bizproc.workflow.instances', {
    select: ['ID', 'MODULE_ID', 'ENTITY', 'DOCUMENT_ID', 'TEMPLATE_ID', 'STARTED', 'MODIFIED'],
  });
  const running = inst.result || inst.instances || [];
  if (inst.__error) { show('bizproc.workflow.instances error', inst); return; }
  console.log(`Активных БП в портале всего: ${running.length}`);
  for (const c of children) {
    // A dynamic item's bizproc DOCUMENT_ID looks like "DYNAMIC_<typeId>_<id>".
    const docTail = `DYNAMIC_${c.entityTypeId}_${c.id}`;
    const mine = running.filter(w => JSON.stringify(w.DOCUMENT_ID || '').includes(String(c.id)) && JSON.stringify(w.DOCUMENT_ID || '').includes(String(c.entityTypeId)));
    console.log(`  • ${c.entityTypeId}#${c.id} «${c.title || ''}» → активных БП: ${mine.length}${mine.length ? ' ' + JSON.stringify(mine.map(m => m.TEMPLATE_ID)) : ''}`);
  }
  show('Пример структуры DOCUMENT_ID (первый активный экземпляр, если есть)', running[0] || '(активных нет)');
}

async function main() {
  const [, , mode, arg] = process.argv;
  if (mode === 'instances') return instances();
  if (mode === 'deal') return dealWalk(parseInt(arg, 10));
  return templates();
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

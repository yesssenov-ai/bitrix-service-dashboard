// probe-bp.js — inspect bizproc templates + active instances, to explain why
// «Шаблон #85» has no name and to see how BPs are referenced.
// Run: node probe-bp.js
const { b24 } = require('./bitrix');
async function call(m, p) { try { return await b24(m, p || {}); } catch (e) { return { __error: e.message }; } }

async function main() {
  const tpl = {};
  let start = 0;
  for (let i = 0; i < 50; i++) {
    const r = await call('bizproc.workflow.template.list', { select: ['ID', 'NAME', 'DOCUMENT_TYPE'], start });
    if (r.__error) { console.log('template.list error:', r.__error); break; }
    (r.result || []).forEach(t => { tpl[String(t.ID)] = t.NAME; });
    if (r.next === undefined || r.next === null) break;
    start = r.next;
  }
  console.log('Всего шаблонов БП:', Object.keys(tpl).length);
  console.log('Шаблон 85:', tpl['85'] !== undefined ? `"${tpl['85']}"` : '❌ НЕ НАЙДЕН в списке (удалён/orphan → имя недоступно)');

  console.log('\nВсе шаблоны (id = name):');
  Object.entries(tpl).sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([id, n]) => console.log(`  ${id} = ${n}`));

  const inst = [];
  start = 0;
  for (let i = 0; i < 100; i++) {
    const r = await call('bizproc.workflow.instances', { select: ['ID', 'DOCUMENT_ID', 'TEMPLATE_ID', 'STARTED'], start });
    if (r.__error) { console.log('instances error:', r.__error); break; }
    inst.push(...(r.result || []));
    if (r.next === undefined || r.next === null) break;
    start = r.next;
  }
  const t85 = inst.filter(w => String(w.TEMPLATE_ID) === '85');
  console.log(`\nАктивных экземпляров с TEMPLATE_ID=85: ${t85.length}`);
  t85.slice(0, 8).forEach(w => console.log(`  workflow ${w.ID} → ${w.DOCUMENT_ID}, старт ${w.STARTED}`));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

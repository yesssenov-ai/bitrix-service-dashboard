// Diagnostic: shows exactly what our planner-sync code sees for ONE item —
// the 4 required fields, whether the "ready" check passes, and (if ready)
// whether the engineer name actually resolves via USERS.
//
// HOW TO RUN: commit, push, wait for deploy, then in Railway Console:
//   node check-item.js <itemId>
// e.g.  node check-item.js 1674

const { getItem } = require('./relations');
const { USERS } = require('./constants');

const itemId = process.argv[2];
if (!itemId) { console.error('Usage: node check-item.js <itemId>'); process.exit(1); }

async function main() {
  const item = await getItem(1058, parseInt(itemId, 10));
  if (!item) { console.log('Item not found (or Bitrix API error) for id', itemId); return; }

  console.log(`Заявка #${itemId}: "${item.title}"\n`);

  const engineerId = parseInt(item.ufCrm8_1732856367, 10);
  const startRaw = item.ufCrm8_1764742554715;
  const endRaw = item.ufCrm8_1764742724958;
  const svcIds = Array.isArray(item.ufCrm8_1744300223) ? item.ufCrm8_1744300223 : (item.ufCrm8_1744300223 ? [item.ufCrm8_1744300223] : []);
  const companyId = parseInt(item.companyId, 10);

  console.log('ufCrm8_1732856367 (Ответственный инженер), raw:', JSON.stringify(item.ufCrm8_1732856367), '→ parsed:', engineerId || '(пусто/не число)');
  console.log('ufCrm8_1764742554715 (Дата начала работ), raw:', JSON.stringify(startRaw));
  console.log('ufCrm8_1764742724958 (Дата окончания работ), raw:', JSON.stringify(endRaw));
  console.log('ufCrm8_1744300223 (Тип оказываемых услуг), raw:', JSON.stringify(item.ufCrm8_1744300223), '→ parsed array:', JSON.stringify(svcIds));
  console.log('companyId (Компания), raw:', JSON.stringify(item.companyId), '→ parsed:', companyId || '(пусто/не число)');

  console.log('\n── Проверка готовности ──');
  const missing = [];
  if (!engineerId) missing.push('инженер');
  if (!startRaw) missing.push('дата начала работ');
  if (!endRaw) missing.push('дата окончания работ');
  if (!svcIds.length) missing.push('вид услуги');
  if (!companyId) missing.push('компания');

  if (missing.length) {
    console.log('НЕ готово — не хватает:', missing.join(', '));
  } else {
    console.log('Все 4 условия выполнены — событие ДОЛЖНО было создаться.');
    const engineerName = USERS[engineerId];
    if (!engineerName) {
      console.log(`НО: Bitrix ID инженера ${engineerId} не найден в справочнике USERS (constants.js) — вот и причина, событие пропускается молча.`);
    } else {
      console.log(`Инженер резолвится как: "${engineerName}" — маппинг в порядке.`);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('Error:', e.message); process.exit(1); });

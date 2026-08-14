// Run in Railway Console: node register-deal-webhook.js
// Registers ONCRMDEALADD/ONCRMDEALUPDATE event handlers with Bitrix,
// pointing at the same webhook URL already used for the planner sync.
// Safe to re-run — Bitrix ignores duplicate bindings for the same event+handler.
const { b24 } = require('./bitrix');

const HANDLER_URL = 'https://nms.prolabsupport.kz/webhook/bitrix-update';

async function main() {
  for (const event of ['ONCRMDEALADD', 'ONCRMDEALUPDATE', 'ONCRMDEALDELETE']) {
    try {
      const { result } = await b24('event.bind', { event, handler: HANDLER_URL });
      console.log(`✅ ${event} зарегистрирован:`, result);
    } catch (e) {
      console.error(`❌ Ошибка регистрации ${event}:`, e.message);
    }
  }

  console.log('\nПроверка текущих подписок (event.get):');
  const { result } = await b24('event.get', {});
  (result || []).forEach(e => console.log(`  ${e.event} -> ${e.handler}`));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

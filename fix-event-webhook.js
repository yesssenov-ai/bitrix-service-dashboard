// Lists (and optionally fixes) the Bitrix event handler registration for
// ONCRMDYNAMICITEMUPDATE — this is how our /webhook/bitrix-update endpoint
// actually gets called. If it was registered via event.bind (REST API)
// rather than the "outbound webhook" admin screen, it won't show up there —
// this is the only place to see/change it.
//
// HOW TO RUN:
//   1. Drop this file into the root of the bitrix-service-dashboard repo
//      (next to bitrix.js), where BITRIX_WEBHOOK is available as an env var.
//   2. First, just list what's registered (read-only, safe):
//        node fix-event-webhook.js
//   3. If it shows the old railway.app URL for ONCRMDYNAMICITEMUPDATE,
//      re-run with --fix to unbind the old one and bind the new domain:
//        node fix-event-webhook.js --fix

const { b24 } = require('./bitrix');

const OLD_URL_FRAGMENT = 'up.railway.app';
const NEW_HANDLER_URL = 'https://nms.prolabsupport.kz/webhook/bitrix-update';
const EVENT_NAME = 'ONCRMDYNAMICITEMUPDATE';

async function main() {
  const doFix = process.argv.includes('--fix');

  console.log('Fetching all registered event handlers...\n');
  const { result } = await b24('event.get');
  const handlers = result || [];

  if (!handlers.length) {
    console.log('No event handlers registered at all via event.bind.');
    console.log('(This likely means the subscription really was set up through');
    console.log('the outbound-webhook admin UI somewhere else, or under a');
    console.log('different Bitrix application/access token than this one.)');
    return;
  }

  console.log(`Total handlers: ${handlers.length}\n`);
  for (const h of handlers) {
    const flag = h.handler?.includes(OLD_URL_FRAGMENT) ? '  ⚠ OLD DOMAIN' : '';
    console.log(`event=${h.event}\thandler=${h.handler}${flag}`);
  }

  const stale = handlers.filter(h =>
    h.event === EVENT_NAME && h.handler?.includes(OLD_URL_FRAGMENT)
  );

  if (!stale.length) {
    console.log(`\nNo ${EVENT_NAME} handler pointing at the old domain was found.`);
    console.log('If you expected one, double-check the event name/URL above manually.');
    return;
  }

  console.log(`\nFound ${stale.length} stale ${EVENT_NAME} handler(s) pointing at the old domain.`);

  if (!doFix) {
    console.log('Re-run with --fix to unbind these and register the new URL:');
    console.log(`  ${NEW_HANDLER_URL}`);
    return;
  }

  for (const h of stale) {
    console.log(`\nUnbinding: ${h.handler}`);
    await b24('event.unbind', { event: EVENT_NAME, handler: h.handler });
  }

  console.log(`Binding new handler: ${NEW_HANDLER_URL}`);
  await b24('event.bind', { event: EVENT_NAME, handler: NEW_HANDLER_URL });

  console.log('\nDone. Re-run without --fix to confirm the new registration.');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });

// Run in Railway Console:
//   node diagnose-bonus.js check 1558 1523
//   node diagnose-bonus.js find "Belpharm" 2026-04-01 2026-06-30
//   node diagnose-bonus.js find "ЖГОК" 2026-04-01 2026-06-30

const { b24call, getItem } = require('./relations');
const { getRootDealManager, getCompanyName, getContractFromChain } = require('./bitrix-lookups');

const REQUEST_ENTITY = 1058;

async function checkRequests(ids) {
  for (const id of ids) {
    console.log(`\n${'='.repeat(20)} Заявка #${id} ${'='.repeat(20)}`);
    const request = await getItem(REQUEST_ENTITY, id);
    if (!request) { console.log('НЕ НАЙДЕНА'); continue; }

    console.log('companyId:', request.companyId);
    console.log('companyName:', request.companyId ? await getCompanyName(request.companyId) : '—');
    console.log('Источник (ufCrm8_1732857572):', request.ufCrm8_1732857572);
    console.log('Тип услуг (ufCrm8_1744300223):', request.ufCrm8_1744300223);
    console.log('Прибор (ufCrmPribor):', request.ufCrmPribor);
    console.log('Дата начала работ:', request.ufCrm8_1764742554715);
    console.log('Дата окончания работ:', request.ufCrm8_1764742724958);

    let contractLabel = '';
    try { contractLabel = await getContractFromChain(REQUEST_ENTITY, request); } catch(e) {}
    console.log('Договор (из цепочки):', contractLabel);

    const dealInfo = await getRootDealManager(REQUEST_ENTITY, request);
    if (dealInfo && dealInfo.deal) {
      console.log('Сделка #:', dealInfo.dealId);
      console.log('Сумма сделки (OPPORTUNITY):', dealInfo.deal.OPPORTUNITY);
      console.log('Валюта (CURRENCY_ID):', dealInfo.deal.CURRENCY_ID);
      console.log('Название сделки:', dealInfo.deal.TITLE);
      console.log('Стадия сделки:', dealInfo.deal.STAGE_ID);
    } else {
      console.log('Родительская сделка НЕ НАЙДЕНА');
    }

    // Show any Отчёты linked to this заявка
    const { result } = await b24call('crm.item.list', {
      entityTypeId: 1046,
      filter: { parentId1058: id },
      select: ['id', 'ufCrm5_1732872053', 'ufCrm5_1732872312', 'ufCrm5_1732872194569', 'ufCrm5_1732872202457'],
    });
    const reports = result?.items || [];
    console.log(`Связанных Отчётов: ${reports.length}`);
    reports.forEach(r => console.log(`  #${r.id}: сотрудник=${r.ufCrm5_1732872053}, соисполнители=${JSON.stringify(r.ufCrm5_1732872312)}, начало=${r.ufCrm5_1732872194569}, конец=${r.ufCrm5_1732872202457}`));
  }
}

async function findByClientName(needle, startDate, endDate) {
  console.log(`\nПоиск заявок (1058) с клиентом, содержащим "${needle}", период ${startDate}..${endDate}\n`);

  // Bitrix doesn't let us filter smart-process items by company NAME
  // directly, so pull items in the date range and check the resolved
  // company name client-side.
  const filter = {
    '>=ufCrm8_1764742554715': startDate,
    '<=ufCrm8_1764742724958': endDate,
  };
  const { result } = await b24call('crm.item.list', {
    entityTypeId: REQUEST_ENTITY, filter,
    select: ['id', 'title', 'companyId', 'ufCrm8_1732857572', 'ufCrm8_1744300223', 'ufCrmPribor', 'ufCrm8_1764742554715', 'ufCrm8_1764742724958'],
  });
  const items = result?.items || [];
  console.log(`Всего заявок в этом диапазоне дат: ${items.length}`);

  let found = 0;
  for (const item of items) {
    const name = item.companyId ? await getCompanyName(item.companyId) : '';
    const titleMatch = (item.title || '').toLowerCase().includes(needle.toLowerCase());
    const nameMatch = (name || '').toLowerCase().includes(needle.toLowerCase());
    if (titleMatch || nameMatch) {
      found++;
      console.log(`\n#${item.id}: ${item.title}`);
      console.log(`  Клиент: ${name}`);
      console.log(`  Источник: ${JSON.stringify(item.ufCrm8_1732857572)}`);
      console.log(`  Тип услуг: ${JSON.stringify(item.ufCrm8_1744300223)}`);
      console.log(`  Прибор: ${JSON.stringify(item.ufCrmPribor)}`);
      console.log(`  Даты: ${item.ufCrm8_1764742554715} — ${item.ufCrm8_1764742724958}`);
    }
  }
  if (!found) console.log('\nНичего не найдено с таким названием клиента в этом диапазоне дат.');
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  if (cmd === 'check') {
    await checkRequests(args.map(Number));
  } else if (cmd === 'find') {
    const [needle, start, end] = args;
    await findByClientName(needle, start, end);
  } else {
    console.log('Usage:\n  node diagnose-bonus.js check <requestId> [<requestId> ...]\n  node diagnose-bonus.js find "<client name fragment>" <startDate> <endDate>');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

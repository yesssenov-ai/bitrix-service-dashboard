const { b24call, getItem } = require('./relations');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { SERVICE_TYPE_MAP, getPriborMap } = require('./bitrix-lookups');

const REPORT_ENTITY = 1046;
const REQUEST_ENTITY = 1058;
const SOURCE_FIELD = 'ufCrm8_1732857572';
const SOURCE_SERVICE_SALE_ID = 95; // "Процесс продажа сервиса"
const SOURCE_INSTRUMENT_SALE_ID = null; // TODO: "Процесс продажа инструментов" — fill in once confirmed (until then, falls back to matching "установ" in the service-type text)

// "Установка"-family service types that trigger the fixed tariff bonus
// instead of the 10% commission (see SERVICE_TYPE_MAP for the full list —
// these are the ones whose Russian label contains "Установ").
function isInstallType(serviceTypeLabel) {
  return /установ/i.test(serviceTypeLabel || '');
}
function isMethodicalType(serviceTypeLabel) {
  return /методич/i.test(serviceTypeLabel || '');
}

async function getReportsInRange(startDate, endDate) {
  const filter = {
    '>=ufCrm5_1732872202457': startDate, // Дата окончания работ/обучения
    '<=ufCrm5_1732872202457': endDate,
  };
  const select = ['id','title','ufCrm5_1732872053','ufCrm5_1732872312','ufCrm5_1732872194569',
                   'ufCrm5_1732872202457','parentId1058','ufCrmPribor'];

  let items = [];
  let start = 0;
  let safety = 0;
  while (safety++ < 50) { // hard ceiling — 50*50=2500 reports, far beyond any realistic quarter
    const data = await b24call('crm.item.list', { entityTypeId: REPORT_ENTITY, filter, select, start });
    if (!data || data.error) {
      throw new Error(`Bitrix crm.item.list ошибка: ${data?.error_description || data?.error || 'нет ответа'}`);
    }
    const page = data.result?.items || [];
    items = items.concat(page);
    if (!data.next) break; // no more pages
    start = data.next;
  }
  return items;
}

// Small delay to stay comfortably under Bitrix's webhook rate limit (2 req/s) —
// each report resolves into several sequential API calls (item, deal, parent
// lookups), and firing them back-to-back for many reports in a row caused
// intermittent failures that silently looked like "no data".
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Resolves one Отчёт into zero or more bonus line items (one per co-executor).
async function resolveReportBonus(report, priborMap) {
  if (!report.parentId1058) return { skipped: true, reason: 'нет связанной заявки (1058)' };

  const request = await getItem(REQUEST_ENTITY, report.parentId1058);
  if (!request) return { skipped: true, reason: 'заявка не найдена' };

  const serviceTypeIds = Array.isArray(request.ufCrm8_1744300223) ? request.ufCrm8_1744300223 : (request.ufCrm8_1744300223 ? [request.ufCrm8_1744300223] : []);
  const serviceTypeLabel = serviceTypeIds.map(id => SERVICE_TYPE_MAP[id] || id).join(', ');

  const rawPribor = request.ufCrmPribor || report.ufCrmPribor;
  const priborIds = Array.isArray(rawPribor) ? rawPribor : (rawPribor ? [rawPribor] : []);
  const priborLabel = priborIds.map(id => priborMap[id] || `#${id}`).join(', ');

  const engineers = [report.ufCrm5_1732872053, ...(Array.isArray(report.ufCrm5_1732872312) ? report.ufCrm5_1732872312 : (report.ufCrm5_1732872312 ? [report.ufCrm5_1732872312] : []))]
    .filter(Boolean).map(id => parseInt(id, 10));
  if (!engineers.length) return { skipped: true, reason: 'не указан сотрудник' };

  const sourceIds = Array.isArray(request[SOURCE_FIELD]) ? request[SOURCE_FIELD] : (request[SOURCE_FIELD] ? [request[SOURCE_FIELD]] : []);
  const isServiceSale = sourceIds.includes(SOURCE_SERVICE_SALE_ID);
  const isInstrumentSale = SOURCE_INSTRUMENT_SALE_ID ? sourceIds.includes(SOURCE_INSTRUMENT_SALE_ID) : null;

  let grossKzt = 0, grossUsd = 0, basis = '';

  // Primary rule: which sales funnel the request came from — confirmed
  // against real historical data to be the reliable signal (the free-text
  // "Тип услуг" label is not: the same contract can have an "Установка" row
  // priced by tariff AND a "Квалификация" row priced as a 10% commission).
  const useTariff = isInstrumentSale === true || (isInstrumentSale === null && isInstallType(serviceTypeLabel));

  if (useTariff) {
    let tariffUsd = 0;
    const matchedCats = new Set();
    for (const pid of priborIds) {
      const { rows } = await pool.query(
        `SELECT c.install_usd, c.methodical_usd, c.name FROM ticketsmodule_instrument_category_map m
         JOIN ticketsmodule_bonus_tariff_categories c ON c.id=m.category_id
         WHERE m.bitrix_pribor_id=$1`, [pid]
      );
      if (!rows.length) continue;
      matchedCats.add(rows[0].name);
      tariffUsd += parseFloat(rows[0].install_usd) || 0;
      tariffUsd += parseFloat(rows[0].methodical_usd) || 0; // both components apply by default — see note above
    }
    if (!tariffUsd) return { skipped: true, reason: `прибор "${priborLabel}" не сопоставлен с категорией тарифа` };
    grossUsd = tariffUsd;
    basis = `Тариф по прибору${isInstrumentSale===null?' (определено по тексту типа услуги — подтвердите ID "Процесс продажа инструментов")':''}: ${[...matchedCats].join(', ')}`;
  } else {
    if (!isServiceSale) {
      return { skipped: true, reason: 'источник заявки — не "Процесс продажа сервиса" и не "Процесс продажа инструментов", бонус не начисляется' };
    }
    const { getRootDealManager } = require('./bitrix-lookups');
    const dealInfo = await getRootDealManager(REQUEST_ENTITY, request);
    if (!dealInfo || !dealInfo.deal) return { skipped: true, reason: 'не найдена родительская сделка' };
    const deal = dealInfo.deal;
    if (!deal.OPPORTUNITY) return { skipped: true, reason: 'у сделки не указана сумма' };

    const sum = parseFloat(deal.OPPORTUNITY);
    const currency = deal.CURRENCY_ID || 'KZT';
    const bonus = sum * 0.10;
    if (currency === 'USD') grossUsd = bonus; else grossKzt = bonus;
    basis = `10% от сделки #${dealInfo.dealId} (${sum} ${currency})`;
  }

  const rate = grossUsd ? await getTodayRate() : null;
  const totalKzt = grossKzt + (grossUsd * (rate || 0));
  const perEngineerKzt = totalKzt / engineers.length;

  return {
    skipped: false,
    reportId: report.id,
    requestId: report.parentId1058,
    basis,
    serviceType: serviceTypeLabel,
    instrument: priborLabel,
    grossKzt, grossUsd, rate, totalKzt,
    engineers, perEngineerKzt,
    workEnd: report.ufCrm5_1732872202457,
  };
}

// Computes the full bonus breakdown for a quarter, grouped by engineer.
async function calculateQuarterBonuses(startDate, endDate) {
  const priborMap = await getPriborMap();
  const reports = await getReportsInRange(startDate, endDate);

  const lineItems = [];
  const skippedItems = [];
  for (const report of reports) {
    const resolved = await resolveReportBonus(report, priborMap);
    if (resolved.skipped) skippedItems.push({ reportId: report.id, reason: resolved.reason });
    else lineItems.push(resolved);
    await sleep(150); // stay under Bitrix's rate limit — see note above getReportsInRange
  }

  const byEngineer = {};
  for (const li of lineItems) {
    for (const engId of li.engineers) {
      if (!byEngineer[engId]) byEngineer[engId] = { engineerId: engId, totalKzt: 0, lines: [] };
      byEngineer[engId].totalKzt += li.perEngineerKzt;
      byEngineer[engId].lines.push({ ...li, shareKzt: li.perEngineerKzt });
    }
  }

  return { byEngineer, skippedItems, totalReports: reports.length };
}

module.exports = { calculateQuarterBonuses, resolveReportBonus, getReportsInRange, SOURCE_SERVICE_SALE_ID };

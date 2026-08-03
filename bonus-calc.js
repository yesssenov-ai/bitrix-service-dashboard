const { b24call, getItem } = require('./relations');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { SERVICE_TYPE_MAP, getPriborMap, getCompanyName } = require('./bitrix-lookups');

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

async function paginatedList(entityTypeId, filter, select) {
  let items = [];
  let start = 0;
  let safety = 0;
  while (safety++ < 50) { // hard ceiling — 50*50=2500 items, far beyond any realistic quarter
    const data = await b24call('crm.item.list', { entityTypeId, filter, select, start });
    if (!data || data.error) {
      throw new Error(`Bitrix crm.item.list ошибка (тип ${entityTypeId}): ${data?.error_description || data?.error || 'нет ответа'}`);
    }
    const page = data.result?.items || [];
    items = items.concat(page);
    if (!data.next) break; // no more pages
    start = data.next;
  }
  return items;
}

const REPORT_SELECT = ['id','title','ufCrm5_1732872053','ufCrm5_1732872312','ufCrm5_1732872194569',
                        'ufCrm5_1732872202457','parentId1058','ufCrmPribor'];

// Pulls every Отчёт relevant to the quarter from TWO angles, then unions them
// by id — a work item only counts once even if it matches both ways:
//   (a) the Отчёт's own "Дата окончания работ" falls in range — the normal case;
//   (b) the отчёт's date is missing/blank, but its parent Заявка's own
//       scheduled work dates (ufCrm8_1764742554715/724958) fall in range —
//       catches отчёты that were never dated, instead of silently dropping them.
async function getReportsInRange(startDate, endDate) {
  const byReportDate = await paginatedList(REPORT_ENTITY, {
    '>=ufCrm5_1732872202457': startDate,
    '<=ufCrm5_1732872202457': endDate,
  }, REPORT_SELECT);

  const requestsByOwnDate = await paginatedList(REQUEST_ENTITY, {
    '>=ufCrm8_1764742554715': startDate,
    '<=ufCrm8_1764742724958': endDate,
  }, ['id']);

  const alreadyCovered = new Set(byReportDate.map(r => r.parentId1058).filter(Boolean));
  const extraRequestIds = requestsByOwnDate.map(r => r.id).filter(id => !alreadyCovered.has(id));

  let extraReports = [];
  for (const reqId of extraRequestIds) {
    // Pull this request's own отчёты regardless of their date (we already
    // know the request's scheduled dates fall in the quarter — that's what
    // matters when the report itself was never dated).
    const reports = await paginatedList(REPORT_ENTITY, { parentId1058: reqId }, REPORT_SELECT);
    extraReports = extraReports.concat(reports);
    await sleep(150);
  }

  const seen = new Set();
  const merged = [];
  for (const r of [...byReportDate, ...extraReports]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(r);
  }
  return merged;
}

// Small delay to stay comfortably under Bitrix's webhook rate limit (2 req/s) —
// each report resolves into several sequential API calls (item, deal, parent
// lookups), and firing them back-to-back for many reports in a row caused
// intermittent failures that silently looked like "no data".
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Resolves ONE Заявка (using its full set of Отчёты in-range) into a single
// bonus line item — the request is the billing unit, not the individual
// report. If several отчёты reference the same заявка (e.g. multiple visits
// or a report per co-executor), the bonus is computed once and split across
// the union of everyone who worked on it.
async function resolveRequestBonus(requestId, reportsForRequest, priborMap) {
  const request = await getItem(REQUEST_ENTITY, requestId);
  if (!request) return { skipped: true, reason: 'заявка не найдена' };

  const serviceTypeIds = Array.isArray(request.ufCrm8_1744300223) ? request.ufCrm8_1744300223 : (request.ufCrm8_1744300223 ? [request.ufCrm8_1744300223] : []);
  const serviceTypeLabel = serviceTypeIds.map(id => SERVICE_TYPE_MAP[id] || id).join(', ');

  const rawPribor = request.ufCrmPribor || reportsForRequest.find(r => r.ufCrmPribor)?.ufCrmPribor;
  const priborIds = Array.isArray(rawPribor) ? rawPribor : (rawPribor ? [rawPribor] : []);
  const priborLabel = priborIds.map(id => priborMap[id] || `#${id}`).join(', ');

  const engineerSet = new Set();
  let earliestWorkStart = null, latestWorkEnd = null;
  for (const report of reportsForRequest) {
    [report.ufCrm5_1732872053, ...(Array.isArray(report.ufCrm5_1732872312) ? report.ufCrm5_1732872312 : (report.ufCrm5_1732872312 ? [report.ufCrm5_1732872312] : []))]
      .filter(Boolean).forEach(id => engineerSet.add(parseInt(id, 10)));
    if (report.ufCrm5_1732872194569 && (!earliestWorkStart || report.ufCrm5_1732872194569 < earliestWorkStart)) earliestWorkStart = report.ufCrm5_1732872194569;
    if (report.ufCrm5_1732872202457 && (!latestWorkEnd || report.ufCrm5_1732872202457 > latestWorkEnd)) latestWorkEnd = report.ufCrm5_1732872202457;
  }
  // Fall back to the заявка's own scheduled work dates if none of its
  // отчёты had one filled in — better than silently dropping the request.
  if (!earliestWorkStart) earliestWorkStart = request.ufCrm8_1764742554715 || null;
  if (!latestWorkEnd) latestWorkEnd = request.ufCrm8_1764742724958 || null;

  const companyName = request.companyId ? await getCompanyName(request.companyId) : '';

  const engineers = [...engineerSet];
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
    requestId,
    reportIds: reportsForRequest.map(r => r.id),
    basis,
    serviceType: serviceTypeLabel,
    instrument: priborLabel,
    grossKzt, grossUsd, rate, totalKzt,
    engineers, perEngineerKzt,
    workStart: earliestWorkStart,
    workEnd: latestWorkEnd,
    companyName,
  };
}

// Computes the full bonus breakdown for a quarter, grouped by engineer.
async function calculateQuarterBonuses(startDate, endDate) {
  const priborMap = await getPriborMap();
  const reports = await getReportsInRange(startDate, endDate);

  const reportsByRequest = new Map();
  for (const report of reports) {
    if (!report.parentId1058) continue;
    const key = report.parentId1058;
    if (!reportsByRequest.has(key)) reportsByRequest.set(key, []);
    reportsByRequest.get(key).push(report);
  }
  const noRequestCount = reports.filter(r => !r.parentId1058).length;

  const lineItems = [];
  const skippedItems = [];
  if (noRequestCount) skippedItems.push({ reportId: null, reason: `${noRequestCount} отчёт(ов) без связанной заявки (1058)` });

  for (const [requestId, reportsForRequest] of reportsByRequest) {
    const resolved = await resolveRequestBonus(requestId, reportsForRequest, priborMap);
    if (resolved.skipped) skippedItems.push({ reportId: requestId, reason: resolved.reason });
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

  return { byEngineer, skippedItems, totalReports: reports.length, totalRequests: reportsByRequest.size };
}

module.exports = { calculateQuarterBonuses, resolveRequestBonus, getReportsInRange, SOURCE_SERVICE_SALE_ID };

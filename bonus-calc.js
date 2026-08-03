const { b24call, getItem, getDeal, findParent } = require('./relations');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { SERVICE_TYPE_MAP, getPriborMap } = require('./bitrix-lookups');

const REPORT_ENTITY = 1046;
const REQUEST_ENTITY = 1058;
const SOURCE_FIELD = 'ufCrm8_1732857572';
const SOURCE_SERVICE_SALE_ID = 95; // "Процесс продажа сервиса"

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
  const { result } = await b24call('crm.item.list', {
    entityTypeId: REPORT_ENTITY,
    filter,
    select: ['id','title','ufCrm5_1732872053','ufCrm5_1732872312','ufCrm5_1732872194569',
             'ufCrm5_1732872202457','parentId1058','ufCrmPribor'],
  });
  return result?.items || [];
}

// Resolves one Отчёт into zero or more bonus line items (one per co-executor).
async function resolveReportBonus(report, priborMap) {
  if (!report.parentId1058) return { skipped: true, reason: 'нет связанной заявки (1058)' };

  const request = await getItem(REQUEST_ENTITY, report.parentId1058);
  if (!request) return { skipped: true, reason: 'заявка не найдена' };

  const serviceTypeIds = Array.isArray(request.ufCrm8_1744300223) ? request.ufCrm8_1744300223 : (request.ufCrm8_1744300223 ? [request.ufCrm8_1744300223] : []);
  const serviceTypeLabel = serviceTypeIds.map(id => SERVICE_TYPE_MAP[id] || id).join(', ');

  const priborIds = Array.isArray(report.ufCrmPribor) ? report.ufCrmPribor : (report.ufCrmPribor ? [report.ufCrmPribor] : []);
  const priborLabel = priborIds.map(id => priborMap[id] || `#${id}`).join(', ');

  const engineers = [report.ufCrm5_1732872053, ...(Array.isArray(report.ufCrm5_1732872312) ? report.ufCrm5_1732872312 : (report.ufCrm5_1732872312 ? [report.ufCrm5_1732872312] : []))]
    .filter(Boolean).map(id => parseInt(id, 10));
  if (!engineers.length) return { skipped: true, reason: 'не указан сотрудник' };

  let grossKzt = 0, grossUsd = 0, basis = '';

  if (isInstallType(serviceTypeLabel)) {
    // Fixed tariff by instrument category
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
      if (isMethodicalType(serviceTypeLabel)) tariffUsd += parseFloat(rows[0].methodical_usd) || 0;
    }
    if (!tariffUsd) return { skipped: true, reason: `прибор "${priborLabel}" не сопоставлен с категорией тарифа` };
    grossUsd = tariffUsd;
    basis = `Установка (тариф): ${[...matchedCats].join(', ')}`;
  } else {
    const sourceIds = Array.isArray(request[SOURCE_FIELD]) ? request[SOURCE_FIELD] : (request[SOURCE_FIELD] ? [request[SOURCE_FIELD]] : []);
    if (!sourceIds.includes(SOURCE_SERVICE_SALE_ID)) {
      return { skipped: true, reason: 'источник заявки — не "Процесс продажа сервиса", бонус не начисляется' };
    }
    const parent = await findParent(REQUEST_ENTITY, request);
    if (!parent || parent.type !== 'deal') return { skipped: true, reason: 'не найдена родительская сделка' };
    const deal = await getDeal(parent.id);
    if (!deal || !deal.OPPORTUNITY) return { skipped: true, reason: 'у сделки не указана сумма' };

    const sum = parseFloat(deal.OPPORTUNITY);
    const currency = deal.CURRENCY_ID || 'KZT';
    const bonus = sum * 0.10;
    if (currency === 'USD') grossUsd = bonus; else grossKzt = bonus;
    basis = `10% от сделки #${parent.id} (${sum} ${currency})`;
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

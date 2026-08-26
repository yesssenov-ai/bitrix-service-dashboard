// ProLab AI — ветка «Реализация» (операционный контроль). Отвечает на запросы про
// сделки из зеркала ticketsmodule_operational_deals: по «Отгрузке от завода»,
// «Поставке по договору», отделу, менеджеру, красному флагу. Даты попадают прямо
// в Excel, чтобы было видно, что выборка ровно по нужному критерию.
const XLSX = require('xlsx');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');
const { getPipelineStages } = require('./operational'); // карта stage_id → читаемое название стадии

const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия', '4860': 'Клеточный анализ',
  '4862': 'ОРМ', '4863': 'Сервис', '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const DEPT_ALIASES = {
  'элементн': ['4857'], 'хроматограф': ['4858'], 'электрохим': ['4859'], 'клеточн': ['4860'],
  'орм': ['4862'], 'расходник': ['4862'], 'сервис': ['4863'], 'тренинг': ['4864'], 'обучен': ['4864'],
  'general lab': ['4865'], 'общелаб': ['4865'], 'материаловед': ['8384'], 'комплекс': ['4866'],
};
const MONTHS = {
  'январ': 1, 'феврал': 2, 'март': 3, 'марте': 3, 'апрел': 4, 'мае': 5, 'май': 5, 'июн': 6, 'июл': 7,
  'август': 8, 'авгус': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
};

function astanaNow() { return new Date(Date.now() + 5 * 3600000); }
function ymd(y, m, d) { return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function lastDay(y, m) { return new Date(y, m, 0).getDate(); }

// Похоже ли это на запрос про «Реализацию» (операционный контроль).
function looksLikeOps(qRaw) {
  const q = String(qRaw || '').toLowerCase();
  return /отгрузк/.test(q)                       // «отгрузка от завода»
    || /поставк[а-яё]*.*договор|договор[а-яё]*.*поставк|срок[а-яё]*.*поставк|поставк[а-яё]*.*срок/.test(q)
    || /красн[а-яё]*\s*флаг/.test(q)
    || /просроч[а-яё]*.*поставк|поставк[а-яё]*.*просроч/.test(q)
    || /реализац/.test(q);
}

// Период: месяц/год из текста. «в августе» → август текущего года.
function detectOpsPeriod(q) {
  const now = astanaNow();
  const curY = now.getFullYear();
  const ql = String(q || '').toLowerCase();
  let year = null;
  const ym = ql.match(/20\d\d/);
  if (ym) year = parseInt(ym[0], 10);
  else if (/прошл[а-яё]*\s*год/.test(ql)) year = curY - 1;
  else if (/следующ[а-яё]*\s*год|будущ[а-яё]*\s*год/.test(ql)) year = curY + 1;
  let month = null;
  for (const [k, v] of Object.entries(MONTHS)) { if (ql.includes(k)) { month = v; break; } }
  if (month) {
    const y = year || curY;
    return { from: ymd(y, month, 1), to: ymd(y, month, lastDay(y, month)), label: `${monName(month)} ${y}` };
  }
  if (/квартал/.test(ql)) {
    const qn = (ql.match(/([1-4])\s*квартал|квартал\s*([1-4])/) || [])[1] || (ql.match(/([1-4])\s*квартал|квартал\s*([1-4])/) || [])[2];
    if (qn) { const y = year || curY; const m0 = (parseInt(qn, 10) - 1) * 3 + 1; return { from: ymd(y, m0, 1), to: ymd(y, m0 + 2, lastDay(y, m0 + 2)), label: `${qn}-й квартал ${y}` }; }
  }
  if (year) return { from: ymd(year, 1, 1), to: ymd(year, 12, 31), label: `${year} год` };
  // период не указан — берём текущий год
  return { from: ymd(curY, 1, 1), to: ymd(curY, 12, 31), label: `${curY} год` };
}
function monName(m) { return ['', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'][m]; }

// По какому полю фильтруем: отгрузка от завода / поставка по договору.
function detectDateField(q) {
  const ql = String(q || '').toLowerCase();
  if (/отгрузк/.test(ql)) return { col: 'factory_ship_date', label: 'Отгрузка от завода' };
  if (/поставк[а-яё]*.*договор|договор[а-яё]*.*поставк|срок[а-яё]*.*поставк/.test(ql)) return { col: 'delivery_by_date', label: 'Поставка по договору' };
  return { col: 'factory_ship_date', label: 'Отгрузка от завода' };
}

function detectDepts(q) {
  const ql = String(q || '').toLowerCase();
  for (const [k, ids] of Object.entries(DEPT_ALIASES)) if (ql.includes(k)) return { ids, label: DEPARTMENT_LABELS[ids[0]] };
  return { ids: null, label: null };
}
function detectManagers(q) {
  const ql = String(q || '').toLowerCase();
  const out = [];
  for (const [id, name] of Object.entries(USERS)) {
    if (!name) continue;
    const parts = String(name).toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    if (parts.some(p => ql.includes(p))) out.push({ id: Number(id), name });
  }
  return out;
}

function parseOps(qRaw) {
  const q = String(qRaw || '');
  const field = detectDateField(q);
  const period = detectOpsPeriod(q);
  const dep = detectDepts(q);
  const managers = detectManagers(q);
  const redFlag = /красн[а-яё]*\s*флаг/.test(q.toLowerCase());
  return { raw: q, field, period, depts: dep.ids, deptLabel: dep.label, managers, redFlag };
}

async function runOps(f) {
  const rate = await getTodayRate();
  const where = [`${f.field.col} IS NOT NULL`, `${f.field.col} >= $1`, `${f.field.col} <= $2`];
  const params = [f.period.from, f.period.to];
  if (f.depts && f.depts.length) { params.push(f.depts); where.push(`department_id = ANY($${params.length})`); }
  if (f.managers && f.managers.length) { params.push(f.managers.map(m => m.id)); where.push(`assigned_by_id = ANY($${params.length})`); }
  if (f.redFlag) where.push('red_flag = true');
  const sql = `SELECT deal_id, category_id, company_name, deal_title, contract_no, stage_id, opportunity, currency_id,
                      assigned_by_id, department_id, delivery_by_date, factory_ship_date, red_flag
               FROM ticketsmodule_operational_deals
               WHERE ${where.join(' AND ')}
               ORDER BY ${f.field.col} ASC`;
  const { rows } = await pool.query(sql, params);
  // Карта «код стадии → название» по каждой встреченной воронке (кэш 1ч внутри).
  const stageMaps = {};
  for (const c of [...new Set(rows.map(r => r.category_id))]) {
    try { const m = await getPipelineStages(c); stageMaps[c] = (m && m.byId) || {}; }
    catch (_) { stageMaps[c] = {}; }
  }
  const items = rows.map(r => {
    const raw = parseFloat(r.opportunity) || 0;
    const sumKzt = r.currency_id === 'USD' ? raw * rate : raw;
    const dBy = toYMD(r.delivery_by_date), fSh = toYMD(r.factory_ship_date);
    const diff = (dBy && fSh) ? Math.round((new Date(dBy) - new Date(fSh)) / 86400000) - 15 : null;
    const sInfo = stageMaps[r.category_id] && stageMaps[r.category_id][r.stage_id];
    return {
      dealId: r.deal_id, company: r.company_name || '', title: r.deal_title || '', contractNo: r.contract_no || '',
      stage: (sInfo && sInfo.name) || r.stage_id || '', deliveryDate: dBy || '', factoryShipDate: fSh || '', diffDays: diff,
      manager: USERS[r.assigned_by_id] || '', dept: DEPARTMENT_LABELS[r.department_id] || '',
      sumKzt: Math.round(sumKzt), currency: r.currency_id || 'KZT', rawSum: raw, redFlag: !!r.red_flag,
    };
  });
  const sumKzt = items.reduce((s, x) => s + x.sumKzt, 0);
  return { items, count: items.length, sumKzt };
}
function toYMD(v) { if (!v) return ''; const d = new Date(v); if (isNaN(d)) return String(v).slice(0, 10); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function interpret(f) {
  const parts = ['Реализация', f.field.label, f.period.label];
  if (f.deptLabel) parts.push('отдел ' + f.deptLabel);
  if (f.managers && f.managers.length) parts.push(f.managers.map(m => m.name).join(', '));
  if (f.redFlag) parts.push('красный флаг');
  return parts.join(' · ');
}

function buildOpsXlsx(items, title, field) {
  const shipHdr = field && field.label ? field.label : 'Отгрузка от завода';
  const header = ['Компания', 'Стадия', '№ договора', 'Название', 'Поставка по договору', 'Отгрузка от завода', 'Разница, дн', 'Менеджер', 'Отдел', 'Сумма (₸)', 'Валюта', 'Сумма (ориг.)', 'Красный флаг', 'ID'];
  const aoa = [header, ...items.map(x => [x.company, x.stage, x.contractNo, x.title, x.deliveryDate, x.factoryShipDate,
    x.diffDays == null ? '' : x.diffDays, x.manager, x.dept, x.sumKzt, x.currency, x.rawSum, x.redFlag ? 'да' : '', x.dealId])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [40, 22, 16, 44, 18, 18, 11, 22, 18, 16, 8, 14, 12, 10].map(w => ({ wch: w }));
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= range.e.r; r++) { const ref = XLSX.utils.encode_cell({ r, c: 9 }); if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0'; }
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (title || 'Реализация').slice(0, 28));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { looksLikeOps, parseOps, runOps, interpret, buildOpsXlsx };

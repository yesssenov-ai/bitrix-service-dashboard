// PLS AI v1 — «умная строка» без внешнего ключа. Разбирает запрос на естественном
// языке по ключевым словам и отдаёт выборку из зеркала сделок (ticketsmodule_stat_deals)
// + выгрузку в Excel. Понимает: производитель, период, «продали/в работе», отдел,
// менеджер, и произвольный текст (прибор/клиент). NL-движок на LLM подключим позже.
const XLSX = require('xlsx');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS } = require('./constants');

// Производители (бренды) — из карты синка. Плюс частые алиасы написания.
const BRANDS = {
  'agilent': 'Agilent', 'agilent technologies': 'Agilent', 'агилент': 'Agilent',
  'metrohm': 'Metrohm', 'метром': 'Metrohm', 'метрохм': 'Metrohm', 'autolab': 'Metrohm Autolab', 'dropsens': 'Metrohm DropSens',
  'malvern': 'Malvern Panalytical', 'panalytical': 'Malvern Panalytical', 'малверн': 'Malvern Panalytical',
  'leco': 'LECO', 'леко': 'LECO', 'wasson': 'Wasson',
  'lni': 'LNI', 'peak': 'Peak Scientific', 'peak scientific': 'Peak Scientific',
  'elga': 'ELGA', 'струерс': 'Struers', 'struers': 'Struers', 'sciaps': 'Sciaps', 'waters': 'Waters',
  'olympus': 'OLYMPUS', 'олимпус': 'OLYMPUS', 'sartorius': 'Sartorius', 'powteq': 'PowTeq',
};
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия', '4860': 'Клеточный анализ',
  '4862': 'ОРМ', '4863': 'Сервис', '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};
const DEPT_ALIASES = {
  'элементный': ['4857'], 'элемент': ['4857'], 'хроматограф': ['4858'], 'хроматография': ['4858'],
  'электрохим': ['4859'], 'клеточн': ['4860'], 'орм': ['4862'], 'расходник': ['4862'],
  'сервис': ['4863'], 'тренинг': ['4864'], 'обучен': ['4864'], 'general lab': ['4865'], 'общелаб': ['4865'],
  'материаловед': ['8384'], 'комплекс': ['4866'],
};
const CONTRACT_SET = [
  'FINAL_INVOICE', '1', 'UC_Q9J6VV', 'UC_9MBFR2', '2', '3', 'WON',
  'C1:FINAL_INVOICE', 'C1:1', 'C1:UC_3MVK90', 'C1:UC_3SCB5K', 'C1:2', 'C1:3', 'C1:WON',
  'C2:FINAL_INVOICE', 'C2:1', 'C2:2', 'C2:WON',
  'C3:FINAL_INVOICE', 'C3:UC_YYTFYG', 'C3:2', 'C3:WON',
];
// Стадии по шагам воронки (все 4 воронки). P10 новый лид … P80 покупка ≤3мес.
const STEP_STAGES = {
  P10: ['NEW', 'C1:NEW', 'C2:NEW', 'C3:NEW'],
  P30: ['PREPARATION', 'C1:PREPARATION', 'C2:PREPARATION', 'C3:PREPARATION'],
  P60: ['PREPAYMENT_INVOICE', 'C1:PREPAYMENT_INVOICE', 'C2:PREPAYMENT_INVOICE', 'C3:PREPAYMENT_INVOICE'],
  P80: ['EXECUTING', 'C1:EXECUTING', 'C2:EXECUTING', 'C3:EXECUTING'],
};
const STEP_ORDER = ['P10', 'P30', 'P60', 'P80'];
const PRECONTRACT = STEP_ORDER.flatMap(s => STEP_STAGES[s]);
const WON_SET = ['WON', 'C1:WON', 'C2:WON', 'C3:WON'];   // только успешно завершённые
const STEP_LABELS = { P10: 'P10 · Новый', P30: 'P30 · Подготовка', P60: 'P60 · КП выставлено', P80: 'P80 · Покупка ≤3 мес' };

// Точные шаблоны месяцев с границами (чтобы «Малверн» не ловился как «май» и т.п.).
const MONTH_RE = [/\bянвар/, /\bфеврал/, /\bмарт/, /\bапрел/, /\bма[йея]\b/, /\bиюн/, /\bиюл/, /\bавгуст/, /\bсентябр/, /\bоктябр/, /\bноябр/, /\bдекабр/];

function detectPeriod(q) {
  const now = new Date();
  const y = now.getFullYear();
  const yr4 = q.match(/\b(20\d{2})\b/);
  if (/за\s+вс|все\s+год|всё\s+время|за\s+весь\s+период/.test(q)) return { from: null, to: null, label: 'за всё время' };
  if (yr4) { const yy = +yr4[1]; return { from: `${yy}-01-01`, to: `${yy}-12-31`, label: `за ${yy} год` }; }
  if (/прошл[а-яё]*\s+год/.test(q)) { const yy = y - 1; return { from: `${yy}-01-01`, to: `${yy}-12-31`, label: `за ${yy} год` }; }
  if (/этот\s+год|текущ[а-яё]*\s+год|в\s+этом\s+год|за\s+год/.test(q)) return { from: `${y}-01-01`, to: `${y}-12-31`, label: `за ${y} год` };
  if (/прошл[а-яё]*\s+месяц/.test(q)) { const d = new Date(y, now.getMonth() - 1, 1); const m = d.getMonth(), yy = d.getFullYear(); return monthRange(yy, m); }
  if (/этот\s+месяц|текущ[а-яё]*\s+месяц|в\s+этом\s+месяц/.test(q)) return monthRange(y, now.getMonth());
  for (let i = 0; i < 12; i++) if (MONTH_RE[i].test(q)) return monthRange(y, i);
  if (/квартал/.test(q)) { const qStart = Math.floor(now.getMonth() / 3) * 3; return { from: ymd(new Date(y, qStart, 1)), to: ymd(new Date(y, qStart + 3, 0)), label: 'за квартал' }; }
  // По умолчанию — текущий год.
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: `за ${y} год` };
}
function monthRange(y, m) { const names = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']; return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)), label: `за ${names[m]} ${y}` }; }
function ymd(d) { return d.toISOString().slice(0, 10); }

// Менеджеры: словарь имя→id из справочника Bitrix.
function managerMatch(q) {
  const found = [];
  for (const [id, name] of Object.entries(USERS)) {
    if (!name || Number(id) <= 6) continue;
    const parts = String(name).toLowerCase().split(/\s+/).filter(p => p.length >= 4);
    if (parts.some(p => q.includes(p))) found.push({ id: Number(id), name });
  }
  return found;
}

function parseQuery(qRaw) {
  const q = String(qRaw || '').toLowerCase().trim();
  const f = { raw: qRaw, brand: null, depts: [], deptLabel: null, managers: [], period: detectPeriod(q), mode: 'sold', steps: null, text: null };
  // ── Явные стадии: P10, P30, P60, P80, диапазоны «P10-P80», «P60 и P80» ──
  const stepTokens = [...new Set((q.match(/p\s?-?\s?(10|30|60|80)/gi) || []).map(s => 'P' + s.match(/(10|30|60|80)/)[1]))]
    .sort((a, b) => STEP_ORDER.indexOf(a) - STEP_ORDER.indexOf(b));
  if (stepTokens.length) {
    const isRange = stepTokens.length >= 2 && /p\s?-?\s?(?:10|30|60|80)\s*[-–—]\s*p\s?-?\s?(?:10|30|60|80)/i.test(q);
    if (isRange) { const lo = STEP_ORDER.indexOf(stepTokens[0]), hi = STEP_ORDER.indexOf(stepTokens[stepTokens.length - 1]); f.steps = STEP_ORDER.slice(lo, hi + 1); }
    else f.steps = stepTokens;
    f.mode = 'steps';
  }
  // ── Семантика режима (если явные стадии не заданы) ──
  else if ((/выдан|выставл/.test(q) && /кп/.test(q)) || /кп\s*выставл/.test(q)) { f.mode = 'steps'; f.steps = ['P60', 'P80']; }
  else if (/выигран|завершён|завершен|успешн|\bwon\b/.test(q)) f.mode = 'won';
  else if (/в\s+работе|pipeline|пайплайн|потенциаль|не\s+подписан|доконтракт|в\s+процессе/.test(q)) f.mode = 'pipe';
  else if (/продал|проданн|законтракт|подписал|контракт|закрыт[а-яё]*\s+сделк/.test(q)) f.mode = 'sold';
  // Бренд
  for (const [k, v] of Object.entries(BRANDS)) if (q.includes(k)) { f.brand = v; break; }
  // Отдел
  for (const [k, ids] of Object.entries(DEPT_ALIASES)) if (q.includes(k)) { f.depts = ids; f.deptLabel = DEPARTMENT_LABELS[ids[0]]; break; }
  // Менеджер
  f.managers = managerMatch(q);
  // Произвольный текст: слова в кавычках («…» / "…"), либо имя после «клиент/компания/заказчик».
  // Осознанно НЕ ловим по «по/прибор/модель» — это слишком часто и рушит запрос.
  const quoted = qRaw.match(/[«"]([^»"]{2,})[»"]/);
  if (quoted) f.text = quoted[1].trim();
  else { const m = qRaw.match(/(?:клиент[ауе]?|компани[июя]\w*|заказчик[ауе]?)\s+([«"]?[A-Za-zА-Яа-я0-9\-\.]{2,30}[»"]?)/i); if (m) f.text = m[1].replace(/[«»"]/g, '').trim(); }
  return f;
}

async function runQuery(f) {
  const rate = await getTodayRate();
  const where = [], args = [];
  const P = v => { args.push(v); return '$' + args.length; };   // добавить параметр, вернуть плейсхолдер
  // Набор стадий и поле даты по режиму:
  //  steps — явные P10/P30/P60/P80 (или «выданные КП» = P60+P80); дата = создания.
  //  pipe  — все доконтрактные P10–P80; дата = создания.
  //  won   — только успешно завершённые (WON); дата = договора.
  //  sold  — законтрактовано: от «Контракт» до «Завершена» (CONTRACT_SET); дата = договора.
  let stageIds, dateField;
  if (f.mode === 'steps') { stageIds = (f.steps || []).flatMap(s => STEP_STAGES[s] || []); dateField = 'date_create'; }
  else if (f.mode === 'pipe') { stageIds = PRECONTRACT; dateField = 'date_create'; }
  else if (f.mode === 'won') { stageIds = WON_SET; dateField = 'contract_date'; }
  else { stageIds = CONTRACT_SET; dateField = 'contract_date'; }
  if (!stageIds.length) stageIds = CONTRACT_SET;
  where.push(`stage_id = ANY('{${stageIds.join(',')}}')`);
  if (f.period.from) { where.push(`${dateField} >= ${P(f.period.from)}`); where.push(`${dateField} <= ${P(f.period.to)}`); }
  else if (dateField === 'contract_date') where.push('contract_date IS NOT NULL');
  if (f.brand) where.push(`manufacturer ILIKE ${P('%' + f.brand.split(' ')[0] + '%')}`);
  if (f.depts.length) where.push(`department_id = ANY(${P(f.depts)})`);
  if (f.managers.length) where.push(`assigned_by_id = ANY(${P(f.managers.map(m => m.id))})`);
  if (f.text) { const p = P('%' + f.text + '%'); where.push(`(instrument_name ILIKE ${p} OR deal_title ILIKE ${p} OR company_name ILIKE ${p})`); }
  const sql = `SELECT deal_id, company_name, manufacturer, instrument_name, opportunity, currency_id,
                      TO_CHAR(contract_date,'YYYY-MM-DD') AS contract_date, TO_CHAR(date_create,'YYYY-MM-DD') AS date_create,
                      stage_id, category_id, assigned_by_id, department_id
                 FROM ticketsmodule_stat_deals
                WHERE ${where.join(' AND ')}
                ORDER BY (CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END) DESC
                LIMIT 5000`;
  const { rows } = await pool.query(sql, args);
  const uname = id => id ? (USERS[id] || ('#' + id)) : '';
  const items = rows.map(r => {
    const sumKzt = (r.currency_id === 'USD' ? (parseFloat(r.opportunity) || 0) * rate : (parseFloat(r.opportunity) || 0));
    return {
      dealId: r.deal_id, company: r.company_name || '', manufacturer: r.manufacturer || '',
      instrument: r.instrument_name || '', sumKzt: Math.round(sumKzt), rawSum: parseFloat(r.opportunity) || 0,
      currency: r.currency_id || 'KZT', contractDate: r.contract_date || '', createDate: r.date_create || '',
      dept: DEPARTMENT_LABELS[r.department_id] || '', manager: uname(r.assigned_by_id),
    };
  });
  const sumKzt = items.reduce((s, x) => s + x.sumKzt, 0);
  return { items, count: items.length, sumKzt, rate };
}

function interpret(f) {
  const parts = [];
  if (f.mode === 'steps') parts.push('Стадии: ' + (f.steps || []).map(s => STEP_LABELS[s] || s).join(', '));
  else if (f.mode === 'pipe') parts.push('В работе (P10–P80)');
  else if (f.mode === 'won') parts.push('Завершённые (успешные)');
  else parts.push('Продано (законтрактовано: Контракт→Завершена)');
  if (f.brand) parts.push('производитель: ' + f.brand);
  if (f.deptLabel) parts.push('отдел: ' + f.deptLabel);
  if (f.managers.length) parts.push('менеджер: ' + f.managers.map(m => m.name).join(', '));
  if (f.text) parts.push('текст: «' + f.text + '»');
  parts.push(f.period.label);
  return parts.join(' · ');
}

function buildXlsx(items, title) {
  const header = ['Компания', 'Прибор', 'Производитель', 'Сумма (₸)', 'Валюта', 'Сумма (ориг.)', 'Стадия', 'Дата договора', 'Дата создания', 'Отдел', 'Менеджер', 'ID сделки'];
  const aoa = [header, ...items.map(x => [x.company, x.instrument, x.manufacturer, x.sumKzt, x.currency, x.rawSum, '', x.contractDate, x.createDate, x.dept, x.manager, x.dealId])];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [40, 34, 18, 16, 8, 14, 10, 14, 14, 20, 22, 10].map(w => ({ wch: w }));
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= range.e.r; r++) { const ref = XLSX.utils.encode_cell({ r, c: 3 }); if (ws[ref] && typeof ws[ref].v === 'number') ws[ref].z = '#,##0'; }
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, (title || 'PLS AI').slice(0, 28));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseQuery, runQuery, interpret, buildXlsx };

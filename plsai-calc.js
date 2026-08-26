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
// Типы приборов → шаблоны ILIKE по названию прибора (instrument_name из зеркала).
// Позволяет сузить «все Agilent» до «только атомники (ААС)» и т.п. Названия моделей —
// из справочника моделей Bitrix. Порядок: более специфичные ГХ-МС/ВЭЖХ-МС раньше общих.
const INSTR_TYPES = [
  { re: /гх-?мс|gc-?ms|масс-?детектор|\bmsd\b|масс-?селективн/i, name: 'ГХ-МС', likes: ['%5977%', '%5975%', '%7000%', '%7010%', '%7250%'] },
  { re: /вэжх-?мс|hplc-?ms|lc-?ms|жидкостн\w*.*масс/i, name: 'ВЭЖХ-МС', likes: ['%6470%', '%6495%', '%6546%', '%Ultivo%', '%6230%', '%6530%', '%6545%', '%6560%', '%Revident%'] },
  { re: /атомн|\baas\b|аас|атомно-?абсорбц/i, name: 'ААС (атомно-абсорбционные)', likes: ['%AA%', '%240 Z%', '%280 Z%'] },
  { re: /исп-?мс|icp-?ms|масс.*(индукт|плазм)/i, name: 'ИСП-МС (ICP-MS)', likes: ['%ICP-MS%'] },
  { re: /исп-?оэс|исп-?аэс|icp-?oes|icp-?aes|оптико-?эмисс.*плазм/i, name: 'ИСП-ОЭС (ICP-OES)', likes: ['%ICP-OES%'] },
  { re: /мп-?аэс|mp-?aes|микроволнов\w*.*плазм/i, name: 'МП-АЭС (MP-AES)', likes: ['%MP-AES%'] },
  { re: /газов\w*.*хроматограф|\bгх\b|\bgc\b/i, name: 'Газовая хроматография', likes: ['%8890%', '%8860%', '%8850%', '%7890%', '%Intuvo%', '%990 Micro%', '%GC%'] },
  { re: /вэжх|жидкостн\w*.*хроматограф|\bhplc\b|\blc\b|инфинити|infinity/i, name: 'Жидкостная хроматография (ВЭЖХ)', likes: ['%Infinity%', '%1220%', '%1260%', '%1290%'] },
  { re: /ионн\w*.*хроматограф|\bic\b|ионн\w* хром/i, name: 'Ионная хроматография', likes: ['%IC %', '%930%', '%940%', '%Eco IC%'] },
  { re: /титратор|титрован/i, name: 'Титраторы', likes: ['%Titrando%', '%Ti-Touch%', '%OMNIS%', '%Titrator%'] },
  { re: /рфа|рентгенофлуор|xrf/i, name: 'РФА (рентгенофлуоресцентные)', likes: ['%Epsilon%', '%Zetium%', '%Axios%', '%X-5%', '%X-2%'] },
];
// Явные номера моделей — если пользователь называет «55», «240», «8890» и т.п.,
// сужаем по вхождению номера в название прибора.
const MODEL_NUMS = ['55', '240', '280', '4210', '5800', '5900', '7850', '7900', '8900', '8890', '8860', '8850', '7890',
  '1220', '1260', '1290', '5977', '5975', '7000', '7010', '7250', '930', '940', '7700'];

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
  // «выдал / выдала / выставил КП», «КП выставлено», «есть КП» → P60 + P80.
  else if ((/выда|выставл|отправ|подготов/.test(q) && /кп|коммерческ/.test(q)) || /кп\s*выставл/.test(q) || /есть\s+кп/.test(q)) { f.mode = 'steps'; f.steps = ['P60', 'P80']; }
  else if (/выигран|завершён|завершен|успешн|\bwon\b/.test(q)) f.mode = 'won';
  else if (/в\s+работе|pipeline|пайплайн|потенциаль|не\s+подписан|доконтракт|в\s+процессе/.test(q)) f.mode = 'pipe';
  else if (/продал|проданн|законтракт|подписал|заключ|контракт|закрыт[а-яё]*\s+сделк/.test(q)) f.mode = 'sold';
  // Бренд
  for (const [k, v] of Object.entries(BRANDS)) if (q.includes(k)) { f.brand = v; break; }
  // Отдел
  for (const [k, ids] of Object.entries(DEPT_ALIASES)) if (q.includes(k)) { f.depts = ids; f.deptLabel = DEPARTMENT_LABELS[ids[0]]; break; }
  // Тип прибора / модель — сужение внутри бренда (напр. Agilent → только ААС → только 55)
  f.instr = { likes: null, label: null, models: [] };
  for (const t of INSTR_TYPES) if (t.re.test(q)) { f.instr.likes = t.likes; f.instr.label = t.name; break; }
  for (const m of MODEL_NUMS) if (new RegExp('(^|[^0-9])' + m + '([^0-9]|$)').test(q)) f.instr.models.push(m);
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
  // Тип прибора (OR по шаблонам) и явные модели (каждая — AND по вхождению номера).
  if (f.instr && f.instr.likes && f.instr.likes.length) {
    where.push('(' + f.instr.likes.map(l => `instrument_name ILIKE ${P(l)}`).join(' OR ') + ')');
  }
  if (f.instr && f.instr.models && f.instr.models.length) {
    for (const m of f.instr.models) where.push(`instrument_name ILIKE ${P('%' + m + '%')}`);
  }
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
  if (f.instr && f.instr.label) parts.push('тип: ' + f.instr.label);
  if (f.instr && f.instr.models && f.instr.models.length) parts.push('модель: ' + f.instr.models.join('/'));
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

// ── Умный разбор через Claude API (если задан ANTHROPIC_API_KEY) ───────────────
// В ИИ уходит ТОЛЬКО текст запроса + список полей/значений — никаких данных клиентов.
// Возвращает структуру намерения (intent) либо null (тогда — откат на keyword-движок).
const LLM_MODEL = process.env.PLSAI_MODEL || 'claude-3-5-haiku-latest';
function astanaToday() { return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); }

// Реальный словарь из зеркала — чтобы ИИ сопоставлял слова с ФАКТИЧЕСКИМИ значениями
// в данных (иначе фильтр промахнётся). Кэш 1 час.
let _vocab = null, _vocabAt = 0;
async function getVocab() {
  if (_vocab && Date.now() - _vocabAt < 3600000) return _vocab;
  const v = { manufacturers: [], departments: [], managers: [], instruments: [], years: '' };
  try {
    const { rows: mf } = await pool.query("SELECT DISTINCT manufacturer FROM ticketsmodule_stat_deals WHERE manufacturer IS NOT NULL AND manufacturer<>'' ORDER BY 1");
    v.manufacturers = mf.map(r => r.manufacturer).slice(0, 80);
    const { rows: dp } = await pool.query('SELECT DISTINCT department_id FROM ticketsmodule_stat_deals WHERE department_id IS NOT NULL');
    v.departments = [...new Set(dp.map(r => DEPARTMENT_LABELS[r.department_id]).filter(Boolean))];
    const { rows: mg } = await pool.query('SELECT DISTINCT assigned_by_id FROM ticketsmodule_stat_deals WHERE assigned_by_id IS NOT NULL');
    v.managers = [...new Set(mg.map(r => USERS[r.assigned_by_id]).filter(Boolean))].sort();
    const { rows: ins } = await pool.query("SELECT DISTINCT instrument_name FROM ticketsmodule_stat_deals WHERE instrument_name IS NOT NULL AND instrument_name<>'' ORDER BY 1");
    v.instruments = ins.map(r => r.instrument_name).slice(0, 400);
    const { rows: yr } = await pool.query('SELECT MIN(EXTRACT(YEAR FROM contract_date))::int a, MAX(EXTRACT(YEAR FROM COALESCE(contract_date,date_create)))::int b FROM ticketsmodule_stat_deals');
    if (yr[0]) v.years = `${yr[0].a || ''}–${yr[0].b || ''}`;
  } catch (e) { /* best-effort */ }
  _vocab = v; _vocabAt = Date.now();
  return v;
}

async function llmIntent(qRaw) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const today = astanaToday();
  const vocab = await getVocab();
  const system = [
    'Ты разбираешь запрос менеджера ProLabSupport о сделках CRM в СТРОГИЙ JSON. Отвечай ТОЛЬКО одним JSON-объектом, без пояснений.',
    `Сегодня ${today} (Астана, UTC+5). Даты в ответе — строки YYYY-MM-DD.`,
    'Поля JSON:',
    'producer: строка или null — производитель (напр. Agilent, Metrohm, Malvern, LECO, Sciaps, Peak, ELGA, LNI, Struers, Waters).',
    'instrument_type: строка или null — тип прибора (AAS/атомно-абсорбционный, ICP-MS, ICP-OES, MP-AES, GC/газовый хроматограф, HPLC/ВЭЖХ, GC-MS, IC/ионная хроматография, titrator/титратор, XRF/РФА). Пиши код латиницей.',
    'models: массив строк — конкретные номера моделей (напр. ["55","240","8890"]). Пусто если не назван.',
    'stage: одно из "kp"|"contract"|"won"|"pipeline"|"custom"|null. "kp"=выдано/выставлено КП (P60,P80); "contract"=продано/законтрактовано/заключён договор (от Контракт до Завершена); "won"=успешно завершено; "pipeline"=в работе (P10-P80); "custom"=явно названы стадии.',
    'steps: массив из "P10","P30","P60","P80" — заполняй только при stage="custom" (диапазон P10-P80 разворачивай в перечисление).',
    'manager: строка или null — имя менеджера как в запросе.',
    'department: строка или null — отдел (Элементный, Хроматография, Электрохимия, ОРМ, Сервис, Тренинг-центр, General Lab, Материаловедение, Комплекс).',
    'client: строка или null — название компании-клиента.',
    'all_time: true если явно просят за всё время/все годы; иначе false.',
    'date_from, date_to: период по датам (YYYY-MM-DD) или null. "этот год"→01.01–31.12 текущего; "прошлый год"→прошлый; "за 2024"→весь 2024; месяц→границы месяца. Если период не указан и all_time=false — оставь null (движок подставит текущий год).',
    'period_label: короткая подпись периода на русском (напр. "за 2024 год") или null.',
    'clarify: строка или null — ЕСЛИ запрос слишком размыт/неоднозначен и по нему нельзя уверенно построить выборку, задай ОДИН короткий уточняющий вопрос по-русски. Если всё понятно — null. Не переспрашивай без реальной нужды.',
    '',
    'ВАЖНО: producer, department, manager подбирай ТОЧНО из списков ниже (это реальные значения в данных). instrument_type определяй по названиям приборов из списка. Если менеджер/производитель не из списка — верни ближайшее по смыслу из списка или null.',
    'Производители: ' + (vocab.manufacturers.join(', ') || '—'),
    'Отделы: ' + (vocab.departments.join(', ') || '—'),
    'Менеджеры: ' + (vocab.managers.join('; ') || '—'),
    'Годы в данных: ' + (vocab.years || '—'),
    'Названия приборов (примеры для определения типа/модели): ' + (vocab.instruments.slice(0, 400).join(', ') || '—'),
  ].join('\n');
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: LLM_MODEL, max_tokens: 400, system, messages: [{ role: 'user', content: String(qRaw || '').slice(0, 500) }] }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!r.ok) { console.error('plsai llm HTTP', r.status); return null; }
    const d = await r.json();
    const txt = (d.content || []).map(c => c.text || '').join('');
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) { console.error('plsai llm error:', e.message); return null; }
}

// intent (из ИИ) → та же структура фильтра f, что и у keyword-парсера.
function intentToFilter(intent, qRaw) {
  const f = { raw: qRaw, brand: null, depts: [], deptLabel: null, managers: [], period: null, mode: 'sold', steps: null,
    instr: { likes: null, label: null, models: [] }, text: null, via: 'ai' };
  // Производитель
  if (intent.producer) {
    const pl = String(intent.producer).toLowerCase();
    let matched = null;
    for (const [k, v] of Object.entries(BRANDS)) if (pl.includes(k) || k.includes(pl)) { matched = v; break; }
    f.brand = matched || intent.producer;
  }
  // Тип прибора
  if (intent.instrument_type) {
    const tl = String(intent.instrument_type).toLowerCase();
    let hit = null;
    for (const t of INSTR_TYPES) if (t.re.test(tl) || t.re.test(String(intent.instrument_type))) { hit = t; break; }
    if (hit) { f.instr.likes = hit.likes; f.instr.label = hit.name; }
    else { f.instr.likes = ['%' + intent.instrument_type + '%']; f.instr.label = intent.instrument_type; }
  }
  if (Array.isArray(intent.models)) f.instr.models = intent.models.map(x => String(x).trim()).filter(Boolean);
  // Отдел
  if (intent.department) {
    const dl = String(intent.department).toLowerCase();
    for (const [k, ids] of Object.entries(DEPT_ALIASES)) if (dl.includes(k)) { f.depts = ids; f.deptLabel = DEPARTMENT_LABELS[ids[0]]; break; }
    if (!f.depts.length) { for (const [id, lbl] of Object.entries(DEPARTMENT_LABELS)) if (lbl.toLowerCase().includes(dl) || dl.includes(lbl.toLowerCase())) { f.depts = [id]; f.deptLabel = lbl; break; } }
  }
  // Менеджер — сначала точное совпадение имени, иначе по токенам
  if (intent.manager) {
    const nm = String(intent.manager).trim().toLowerCase();
    const exact = Object.entries(USERS).find(([, n]) => n && n.toLowerCase() === nm);
    f.managers = exact ? [{ id: Number(exact[0]), name: exact[1] }] : managerMatch(nm);
  }
  // Клиент
  if (intent.client) f.text = String(intent.client).trim();
  // Режим/стадии
  switch (intent.stage) {
    case 'kp': f.mode = 'steps'; f.steps = ['P60', 'P80']; break;
    case 'won': f.mode = 'won'; break;
    case 'pipeline': f.mode = 'pipe'; break;
    case 'custom': {
      const s = (Array.isArray(intent.steps) ? intent.steps : []).map(x => String(x).toUpperCase()).filter(x => STEP_ORDER.includes(x));
      if (s.length) { f.mode = 'steps'; f.steps = s.sort((a, b) => STEP_ORDER.indexOf(a) - STEP_ORDER.indexOf(b)); }
      else f.mode = 'sold';
      break;
    }
    case 'contract': default: f.mode = 'sold';
  }
  // Период
  if (intent.all_time) f.period = { from: null, to: null, label: 'за всё время' };
  else if (intent.date_from) {
    const to = intent.date_to || intent.date_from;
    f.period = { from: intent.date_from, to, label: intent.period_label || `${intent.date_from} … ${to}` };
  } else f.period = detectPeriod('');   // не указан — текущий год (как в keyword)
  return f;
}

function intentHasFilter(intent) {
  return !!(intent && (intent.producer || intent.instrument_type || (intent.models && intent.models.length) ||
    intent.manager || intent.department || intent.client || intent.stage ||
    intent.date_from || intent.all_time));
}

// Главный вход: {f, ai, clarify}. Если ИИ размыт и фильтров нет — просим уточнить.
async function analyze(qRaw) {
  const intent = await llmIntent(qRaw);
  if (intent) {
    if (intent.clarify && !intentHasFilter(intent)) return { f: null, ai: true, clarify: String(intent.clarify) };
    try { return { f: intentToFilter(intent, qRaw), ai: true, clarify: intent.clarify ? String(intent.clarify) : null }; }
    catch (e) { /* упадём на keyword */ }
  }
  return { f: parseQuery(qRaw), ai: false, clarify: null };
}

// Совместимость: только фильтр (без clarify).
async function parseSmart(qRaw) { const a = await analyze(qRaw); return a.f || parseQuery(qRaw); }

module.exports = { parseQuery, parseSmart, analyze, runQuery, interpret, buildXlsx, intentToFilter, getVocab };

// portal-today.js — данные блока «Сегодня в компании» на главной портала.
// Дни рождения — из загруженного списка сотрудников (66). «В этот день» и «Пульс»
// тянутся из Bitrix (best-effort, кэш). Отсутствия — из таблицы ЦУП (ввод HR/админ).
const { b24 } = require('./bitrix');
let USERS = {};
try { USERS = require('./constants').USERS || {}; } catch (e) {}

const BIRTHDAYS = [
  {"d": 10, "m": 1, "name": "Акмурзина Бактыгул Мырзагалиевна"},
  {"d": 12, "m": 1, "name": "Жарылғап Әсем Дауылбайқызы"},
  {"d": 17, "m": 1, "name": "Бодров Игорь Вячеславович"},
  {"d": 19, "m": 1, "name": "Шотанова Акерке Маратовна"},
  {"d": 25, "m": 1, "name": "Амангелді Талант Талғатұлы"},
  {"d": 28, "m": 1, "name": "Аймуратова Мерует Жиенбековна"},
  {"d": 26, "m": 2, "name": "Төлеуханова Балауса Ерікқызы"},
  {"d": 28, "m": 2, "name": "Мазняк Максим Викторович"},
  {"d": 1, "m": 3, "name": "Орахбаев Данияр Ташкенбаевич"},
  {"d": 2, "m": 3, "name": "Чоговадзе Каха"},
  {"d": 22, "m": 3, "name": "Негметжанов Дарын Болатулы"},
  {"d": 25, "m": 3, "name": "Рымбек Шоқан Жәнібекұлы"},
  {"d": 28, "m": 3, "name": "Кунаев Жандос Абылкаирович"},
  {"d": 13, "m": 4, "name": "Қасен Руслан Қайратұлы"},
  {"d": 16, "m": 4, "name": "Самиголлаева Акгулим Бериккалиевна"},
  {"d": 18, "m": 4, "name": "Адильбеков Ерлан Нурланович"},
  {"d": 29, "m": 4, "name": "Тасмагамбетов Адиль Серикович"},
  {"d": 1, "m": 5, "name": "Оразғалиев Нұрхат Айдарұлы"},
  {"d": 1, "m": 5, "name": "Егоров Борис Николаевич"},
  {"d": 2, "m": 5, "name": "Қапар Елнүра Айдарқызы"},
  {"d": 5, "m": 5, "name": "Сыздыков Аманжол Жолдыбаевич"},
  {"d": 6, "m": 5, "name": "Кравченко Святослава Андреевна"},
  {"d": 14, "m": 5, "name": "Махаш Ерасыл Əуезұлы"},
  {"d": 16, "m": 5, "name": "Сырғабек Ерқанат Арқынұлы"},
  {"d": 19, "m": 5, "name": "Марат Назерке Нұрланқызы"},
  {"d": 22, "m": 5, "name": "Чакраборти Соня Джаянтовна"},
  {"d": 10, "m": 6, "name": "Ибраемов Нурбек Ардакулы"},
  {"d": 13, "m": 6, "name": "Касымханова Гулнур Сайлаухановна"},
  {"d": 14, "m": 6, "name": "Доскенова Маржан Жанболатовна"},
  {"d": 15, "m": 6, "name": "Уваисова Мадина Галижановна"},
  {"d": 16, "m": 6, "name": "Сорокин Дмитрий Сергеевич"},
  {"d": 24, "m": 6, "name": "Болатова Аруна Ержанқызы"},
  {"d": 2, "m": 7, "name": "Манат Азат Асқарұлы"},
  {"d": 4, "m": 7, "name": "Ляшев Алмат Калиолдаевич"},
  {"d": 4, "m": 7, "name": "Волков Дмитрий Николаевич"},
  {"d": 5, "m": 7, "name": "Көбей Асқат Болатбекұлы"},
  {"d": 6, "m": 7, "name": "Мухамеджанов Андрей Юрьевич"},
  {"d": 20, "m": 7, "name": "Разакова Айнұр Құрманқызы"},
  {"d": 21, "m": 7, "name": "Карпсеитова Айнур Жетписовна"},
  {"d": 24, "m": 7, "name": "Нұржанова Рабиға Арманқызы"},
  {"d": 27, "m": 7, "name": "Есенов Куаныш Есенович"},
  {"d": 27, "m": 7, "name": "Жаров Семен Андреевич"},
  {"d": 11, "m": 8, "name": "Ниязов Арыстанбек Нурболатович"},
  {"d": 19, "m": 8, "name": "Зенченко Наталья Сергеевна"},
  {"d": 20, "m": 8, "name": "Абылкасимов Рустам Сапаргалиевич"},
  {"d": 21, "m": 8, "name": "Сейтжанұлы Мансұр"},
  {"d": 22, "m": 8, "name": "Жунусов Канат Талгатович"},
  {"d": 28, "m": 8, "name": "Аннабаев Азамат Сапарбаевич"},
  {"d": 9, "m": 9, "name": "Байжигитова Айжан Муктаркановна"},
  {"d": 16, "m": 9, "name": "Бахтен Бақытжан Маратұлы"},
  {"d": 23, "m": 9, "name": "Ахметжан Гауһар Маранқызы"},
  {"d": 30, "m": 9, "name": "Даут Бакытгүл"},
  {"d": 7, "m": 10, "name": "Лекер Аннель Саматовна"},
  {"d": 12, "m": 10, "name": "Нурмаганбетов Куаныш Арманович"},
  {"d": 14, "m": 10, "name": "Булегенов Мурат Кабидолдаевич"},
  {"d": 20, "m": 10, "name": "Садырова Дамели Нуртаевна"},
  {"d": 21, "m": 10, "name": "Актайлаков Мирас Ермекович"},
  {"d": 28, "m": 10, "name": "Пономарев Олег Николаевич"},
  {"d": 10, "m": 11, "name": "Орынбаева Айнұр Серікқызы"},
  {"d": 14, "m": 11, "name": "Жақсылық Рауан Болатбекұлы"},
  {"d": 21, "m": 11, "name": "Сагитова Жадыра Баймуратовна"},
  {"d": 21, "m": 11, "name": "Шаймұрат Бақытжан Булатұлы"},
  {"d": 2, "m": 12, "name": "Карпушенко Виталий Александрович"},
  {"d": 7, "m": 12, "name": "Казиев Исабек Сигматович"},
  {"d": 21, "m": 12, "name": "Манаспаев Арман Игликович"},
  {"d": 26, "m": 12, "name": "Сеитова Айнель Бериковна"}
];

const MON_SH = ['', 'янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const FACTS = [
  'Тренинг-центр — единственная в регионе лаборатория с обучением по ВЭЖХ «под ключ».',
  'ProLabSupport обслуживает аналитическое оборудование по всему Казахстану.',
  'Самый частый запрос месяца в сервис — профилактика и поверка приборов.',
  'Каждая успешная сделка начиналась с одного звонка. Сегодня — твой день звонков 🙂',
  'Довольный клиент приводит в среднем ещё двух. Сервис — это продажи завтра.',
];

// День рождения сегодня + ближайшие 7 дней.
function birthdays(now) {
  now = now || new Date();
  const d = now.getDate(), m = now.getMonth() + 1;
  const today = BIRTHDAYS.filter(b => b.d === d && b.m === m).map(b => b.name);
  const upcoming = [];
  for (let i = 1; i <= 7; i++) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const dd = dt.getDate(), mm = dt.getMonth() + 1;
    const names = BIRTHDAYS.filter(b => b.d === dd && b.m === mm).map(b => b.name);
    if (names.length) upcoming.push({ date: dd + ' ' + MON_SH[mm], names });
  }
  return { today, upcoming };
}

// «В этот день N лет назад» — крупнейшая выигранная сделка этого дня-месяца по годам.
let _otd = { key: '', data: null, at: 0 };
async function onThisDay(now) {
  now = now || new Date();
  const dd = String(now.getDate()).padStart(2, '0'), mm = String(now.getMonth() + 1).padStart(2, '0');
  const key = mm + '-' + dd;
  if (_otd.key === key && _otd.data && Date.now() - _otd.at < 6 * 3600 * 1000) return _otd.data;
  const out = [];
  try {
    const yThis = now.getFullYear();
    for (let y = yThis - 1; y >= yThis - 6; y--) {
      const res = await b24('crm.deal.list', {
        filter: { '>=CLOSEDATE': y + '-' + mm + '-' + dd + 'T00:00:00', '<=CLOSEDATE': y + '-' + mm + '-' + dd + 'T23:59:59', CLOSED: 'Y', STAGE_SEMANTIC_ID: 'S' },
        select: ['ID', 'TITLE', 'OPPORTUNITY', 'CURRENCY', 'ASSIGNED_BY_ID'],
        order: { OPPORTUNITY: 'DESC' }, start: 0,
      });
      const rows = (res && res.result) || [];
      if (rows.length) {
        const top = rows[0];
        out.push({ yearsAgo: yThis - y, year: y, title: top.TITLE || 'Сделка',
          amount: +top.OPPORTUNITY || 0, currency: top.CURRENCY || 'KZT',
          manager: USERS[String(top.ASSIGNED_BY_ID)] || '', count: rows.length });
      }
    }
  } catch (e) { /* Bitrix недоступен — блок просто не покажется */ }
  _otd = { key, data: out, at: Date.now() };
  return out;
}

// Пульс компании — три дешёвых счётчика (total из Bitrix).
let _pulse = { at: 0, data: null };
async function pulse(now) {
  now = now || new Date();
  if (_pulse.data && Date.now() - _pulse.at < 30 * 60 * 1000) return _pulse.data;
  const cnt = async (method, params) => {
    try { const r = await b24(method, Object.assign({ select: ['ID'] }, params));
      return (r && typeof r.total === 'number') ? r.total : ((r && r.result && r.result.length) || 0);
    } catch (e) { return null; }
  };
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0'), d = String(now.getDate()).padStart(2, '0');
  const out = {};
  out.inWork = await cnt('crm.deal.list', { filter: { CLOSED: 'N' } });
  out.closedMonth = await cnt('crm.deal.list', { filter: { CLOSED: 'Y', STAGE_SEMANTIC_ID: 'S', '>=CLOSEDATE': y + '-' + m + '-01T00:00:00' } });
  out.leadsToday = await cnt('crm.lead.list', { filter: { '>=DATE_CREATE': y + '-' + m + '-' + d + 'T00:00:00' } });
  _pulse = { at: Date.now(), data: out };
  return out;
}

function dailyFact(now) {
  now = now || new Date();
  const doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
  return FACTS[doy % FACTS.length];
}

// ── «Факт дня»: живая сводка по данным + ежедневный ИИ-вывод (Claude Haiku) ─────
// Живая строка — из уже собранных цифр (без доп. запросов).
function dayInsight(pulse, absences) {
  const p = pulse || {}; const parts = [];
  if (p.inWork != null) parts.push(`в работе ${Number(p.inWork).toLocaleString('ru-RU')} сделок`);
  if (p.closedMonth != null) parts.push(`за месяц закрыто ${p.closedMonth}`);
  const n = (absences || []).length; if (n) parts.push(`вне офиса ${n}`);
  const s = parts.join(' · ');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}
// ИИ-вывод: 1–2 деловых предложения от Claude по цифрам дня. Кэш на сутки,
// генерация в фоне (не блокирует ответ). Без ключа/при ошибке — пустая строка.
let _ai = { date: '', text: '', pending: false, state: '' };
const _aiKey = now => now.toISOString().slice(0, 10);
// Сводка по дебиторке для ИИ-вывода (читается только при генерации — раз в день).
async function debtRisk() {
  try {
    const { getDebtBoard } = require('./finance-debt-calc');
    const b = await getDebtBoard({});
    const rows = (b && b.rows) || [];
    const over = rows.filter(r => Number(r.overdue_days) > 0);
    const top = over.slice().sort((a, c) => (c.overdue_days - a.overdue_days) || (c.debt - a.debt)).slice(0, 5)
      .map(r => ({ contractor: r.contractor, debt: Math.round(r.debt), overdueDays: r.overdue_days }));
    return {
      totalDebt: Math.round((b.totals && b.totals.debt) || 0),
      totalOverdue: Math.round((b.totals && b.totals.overdue) || 0),
      overdueSharePct: (b.totals && b.totals.debt) ? Math.round(b.totals.overdue / b.totals.debt * 100) : 0,
      maxOverdueDays: over.reduce((m, r) => Math.max(m, Number(r.overdue_days) || 0), 0),
      debtorsOver90: over.filter(r => r.overdue_days > 90).length,
      debtorsOver180: over.filter(r => r.overdue_days > 180).length,
      topOverdue: top, isDemo: !!(b && b.mock),
    };
  } catch (e) { return null; }
}
async function _genAi(ctx) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) { _ai.state = 'no-key'; return ''; }
  let debt = null; try { debt = await debtRisk(); } catch (e) {}
  const full = debt ? Object.assign({}, ctx, { debt }) : ctx;
  const sys = 'Ты — ассистент технического директора лабораторной компании ProLabSupport (сервис и продажи аналитического оборудования). По цифрам дня дай один короткий деловой вывод на русском (1–2 предложения, максимум 35 слов): на что обратить внимание сегодня. ПРИОРИТЕТ — риски по дебиторской задолженности: если есть просрочка с большими сроками (свыше 90–180 дней) или крупными суммами, предупреди в первую очередь — назови контрагента и срок/сумму и порекомендуй действие (напоминание, эскалация). Суммы в млн ₸. Строго, по делу, без приветствий, без воды, без эмодзи. Если данные помечены isDemo, пиши нейтрально без тревоги.';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.PLSAI_AGENT_MODEL || process.env.PLSAI_MODEL || 'claude-haiku-5-5', max_tokens: 220, system: sys,
        messages: [{ role: 'user', content: 'Цифры на сегодня:\n' + JSON.stringify(full) }] }),
    });
    const d = await r.json();
    if (!r.ok) { _ai.state = 'api-error: ' + ((d && d.error && d.error.message) || ('HTTP ' + r.status)); return ''; }
    const t = ((d.content && d.content[0] && d.content[0].text) || '').trim();
    _ai.state = t ? 'ok' : 'empty-response';
    return t;
  } catch (e) { _ai.state = 'fetch-error: ' + e.message; return ''; }
}
function aiDigest(now, ctx) {
  const k = _aiKey(now);
  if (_ai.date === k && _ai.text) return _ai.text;
  if (!_ai.pending) {
    _ai.pending = true; if (!_ai.state) _ai.state = 'pending';
    _genAi(ctx).then(t => { _ai.date = k; _ai.text = t || ''; _ai.pending = false; }).catch(() => { _ai.pending = false; });
  }
  return _ai.date === k ? _ai.text : '';
}
function aiState() { return _ai.state || ''; }

// Кто сегодня отсутствует (таблица ЦУП — отпуск/больничный, ручной ввод).
async function absencesToday(pool, now) {
  try {
    const iso = (now || new Date()).toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT name, kind, from_date, to_date FROM ticketsmodule_portal_absences
       WHERE (from_date = '' OR from_date <= $1) AND (to_date = '' OR to_date >= $1)
       ORDER BY kind, name`, [iso]);
    return rows;
  } catch (e) { return []; }
}

// ── Смарт-процессы Bitrix: «Командировки» и «Отпуска» ──────────────────────────
// Для каждого процесса автоопределяем entityTypeId по названию. Командировки —
// строго по этапу «В командировке»; отпуска — актуальные на сегодня по датам
// (today в диапазоне дат записи). Сотрудник = ответственный (assignedById→USERS),
// иначе заголовок. Даты полей определяем эвристически (кроме системных).
const _DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const _pdate = v => { const m = _DATE_RE.exec(String(v || '')); return m ? (m[1] + '-' + m[2] + '-' + m[3]) : null; };
// Значение поля по коду с учётом расхождения регистра/подчёркиваний между
// crm.item.fields (напр. UF_CRM_..) и crm.item.list (ufCrm..).
const _normKey = k => String(k).toLowerCase().replace(/_/g, '');
function itemVal(it, code) {
  if (code == null) return undefined;
  if (it[code] !== undefined) return it[code];
  const nk = _normKey(code);
  for (const k in it) { if (_normKey(k) === nk) return it[k]; }
  return undefined;
}
// Из заголовка «ФИО - ДД.ММ.ГГГГ ЧЧ:ММ:СС - вид работ - город» вырезаем префикс
// (ФИО + дата-время), оставляя «вид работ - город».
const _descrFromTitle = t => String(t || '').replace(/^.*?\d{1,2}\.\d{1,2}\.\d{4}[\s\d:]*[-–]\s*/, '').trim();
const _sp = {};   // key → { at, id, stages:Set, stageKey }
async function spTypeId(reName, key) {
  const c = _sp[key];
  if (c && c.id != null && Date.now() - c.at < 6 * 3600 * 1000) return c.id;
  let id = null;
  try {
    const r = await b24('crm.type.list', {});
    const types = (r && r.result && r.result.types) || [];
    const t = types.find(x => reName.test(x.title || ''));
    if (t) id = t.entityTypeId;
  } catch (e) { /* нет доступа */ }
  _sp[key] = { at: Date.now(), id, stages: null, stageKey: '', fields: null };
  return id;
}
// Коды полей «дата начала» и «дата окончания» процесса — по названию поля.
// ВАЖНО: предпочитаем поле, в названии которого есть И слово начала/окончания,
// И доменное слово процесса (reDomain: «командировк»/«отпуск»), т.е. именно
// «Начало командировки», а не «Дата начала» (begindate — дата заявки). Берём
// только date-поля. reDomain-совпадение имеет приоритет над любым другим.
async function spDateFields(etid, key, reDomain) {
  const c = _sp[key];
  if (c && c.fields) return c.fields;
  let startD = null, startG = null, endD = null, endG = null;
  try {
    const r = await b24('crm.item.fields', { entityTypeId: etid });
    const fields = (r && r.result && r.result.fields) || {};
    for (const code in fields) {
      const f = fields[code] || {};
      if (!/date/i.test(String(f.type || ''))) continue;
      const title = String(f.title || '').toLowerCase();
      const dom = reDomain ? reDomain.test(title) : false;
      if (/нача/.test(title)) { if (dom) { if (!startD) startD = code; } else if (!startG) startG = code; }
      if (/оконч|конец/.test(title)) { if (dom) { if (!endD) endD = code; } else if (!endG) endG = code; }
    }
  } catch (e) { /* нет доступа — сработает фолбэк */ }
  const ff = { start: startD || startG, end: endD || endG };
  if (c) c.fields = ff;
  return ff;
}
async function spStageIds(etid, key, reStage) {
  const c = _sp[key];
  if (c && c.stages && c.stageKey === String(reStage)) return c.stages;
  const ids = new Set();
  try {
    let start = 0, guard = 0;
    while (guard++ < 20) {
      const r = await b24('crm.status.list', { start });
      for (const s of (r && r.result) || []) {
        if (String(s.ENTITY_ID || '').indexOf('DYNAMIC_' + etid + '_') === -1) continue;
        if (reStage.test(s.NAME || '')) ids.add(String(s.STATUS_ID));
      }
      const next = r && r.next; if (next === undefined || next === null) break; start = next;
    }
  } catch (e) { /* нет доступа — пустой набор, сработает фолбэк по датам */ }
  if (c) { c.stages = ids; c.stageKey = String(reStage); }
  return ids;
}
// Активные записи процесса на сегодня. opts: { reName, key, kind, reStage? }.
async function spActive(now, opts) {
  const out = []; const todayISO = now.toISOString().slice(0, 10);
  try {
    const etid = await spTypeId(opts.reName, opts.key);
    if (!etid) return out;
    const stageIds = opts.reStage ? await spStageIds(etid, opts.key, opts.reStage) : new Set();
    const deadIds = opts.reDead ? await spStageIds(etid, opts.key + '_dead', opts.reDead) : new Set();
    const df = await spDateFields(etid, opts.key, opts.reDomain);
    // ВАЖНО: фильтруем по этапу на стороне Bitrix. Иначе crm.item.list отдаёт
    // только первую страницу (≈50) по id desc, и активная командировка со старой
    // карточкой (как у Нурхата) не попадает в выборку из-за сотен свежих «Отчётов».
    const listBase = { entityTypeId: etid, select: ['*', 'uf_*'], order: { id: 'desc' } };
    if (opts.all) {
      // Режим «все записи» (для календаря ТЦ): без этапа и без «активно сегодня»,
      // фильтр по окну дат на стороне Bitrix (начало ≤ конца окна и конец ≥ начала окна).
      const f = {}, win = opts.window || {};
      if (df.start && win.to) f['<=' + df.start] = win.to;
      if (df.end && win.from) f['>=' + df.end] = win.from;
      if (Object.keys(f).length) listBase.filter = f;
    } else if (opts.reStage && stageIds.size) listBase.filter = { '@stageId': [...stageIds] };
    let items = [], start = 0, guard = 0;
    while (guard++ < 8) {
      const r = await b24('crm.item.list', Object.assign({ start }, listBase));
      const batch = (r && r.result && r.result.items) || [];
      items = items.concat(batch);
      const next = r && r.next;
      if (next === undefined || next === null || batch.length === 0) break;
      start = next;
    }
    for (const it of items) {
      // Приоритет — конкретные поля начала/окончания. Фолбэк (если поля не нашлись)
      // — эвристика мин/макс с защитой по длине диапазона.
      let from = df.start ? _pdate(itemVal(it, df.start)) : null;
      let to = df.end ? _pdate(itemVal(it, df.end)) : null;
      if (!from || !to) {
        const dates = [];
        for (const k in it) { if (/creat|updat|mov|activ|communicat/i.test(k)) continue;
          const d = _pdate(it[k]); if (d) dates.push(d); }
        dates.sort();
        const hf = dates[0] || '', ht = dates[dates.length - 1] || '';
        const span = hf && ht ? (Date.parse(ht + 'T00:00:00') - Date.parse(hf + 'T00:00:00')) / 864e5 : -1;
        if (hf && ht && span >= 0 && span <= 62) { from = from || hf; to = to || ht; }
      }
      if (!from || !to) continue;
      // Отсекаем отменённые/несостоявшиеся записи (этап «Провал», «не состоялась»).
      if (deadIds.size && deadIds.has(String(it.stageId))) continue;
      // Активно сегодня (from ≤ today ≤ to). Для командировок дополнительно требуем
      // этап «В командировке» — только он означает, что человек в поездке прямо сейчас.
      let include;
      if (opts.all) { const win = opts.window || {};
        include = (!win.to || from <= win.to) && (!win.from || to >= win.from);   // перекрытие с окном
      } else {
        include = (from <= todayISO && todayISO <= to);
        if (opts.reStage && stageIds.size) include = include && stageIds.has(String(it.stageId));
      }
      if (!include) continue;
      const who = USERS[String(it.assignedById)] || _descrFromTitle(it.title) || 'Сотрудник';
      // Для командировок: «вид работ - город» из заголовка + компания (резолвим позже).
      const descr = opts.kind === 'trip' ? _descrFromTitle(it.title) : '';
      out.push({ name: who, kind: opts.kind, from_date: from, to_date: to, dest: descr, companyId: it.companyId || null });
    }
  } catch (e) { /* процесс недоступен */ }
  return out;
}
let _smart = { at: 0, data: null };
async function smartAbsences(now) {
  now = now || new Date();
  if (_smart.data && Date.now() - _smart.at < 15 * 60 * 1000) return _smart.data;
  const [trips, vac] = await Promise.all([
    // Командировки: поля «Начало/Окончание командировки», этап строго «В командировке».
    spActive(now, { reName: /командиров/i, key: 'trip', kind: 'trip',
      reDomain: /команди?ровк/i, reStage: /^в\s+команди?ровк/i }),
    // Отпуска: поля «Дата начала/окончания отпуска», по датам; отменённые отсекаем.
    spActive(now, { reName: /отпуск/i, key: 'vac', kind: 'vacation',
      reDomain: /отпуск/i, reDead: /провал|fail|отклон|не\s*состоя/i }),
  ]);
  // Компании командировок — одним запросом по companyId.
  try {
    const ids = [...new Set(trips.map(t => t.companyId).filter(Boolean))];
    if (ids.length) {
      const r = await b24('crm.company.list', { filter: { '@ID': ids }, select: ['ID', 'TITLE'] });
      const comp = {}; for (const c of (r && r.result) || []) comp[String(c.ID)] = c.TITLE;
      for (const t of trips) { const nm = comp[String(t.companyId)]; if (nm) t.dest = (t.dest ? t.dest + ' · ' : '') + nm; }
    }
  } catch (e) { /* компании не критичны */ }
  for (const t of trips) delete t.companyId;
  // Дедуп: одна строка на человека в рамках типа (у сотрудника может быть
  // несколько записей — для сводки «кто отсутствует» достаточно одной).
  const seen = new Set(); const data = [];
  for (const a of trips.concat(vac)) { const key = a.kind + '|' + a.name; if (seen.has(key)) continue; seen.add(key); data.push(a); }
  _smart = { at: Date.now(), data };
  return data;
}
// Все командировки/отпуска в окне [fromISO..toISO] — без фильтра «активно сегодня»
// и без фильтра по этапу (для календаря ТЦ, где нужен весь период, а не только сейчас).
// Дедуп НЕ делаем: у человека может быть несколько поездок в разные даты.
let _allAbs = { at: 0, key: '', data: null };
async function allAbsences(fromISO, toISO) {
  const now = new Date();
  const win = { from: fromISO || '0000-01-01', to: toISO || '9999-12-31' };
  const ckey = win.from + '…' + win.to;
  if (_allAbs.data && _allAbs.key === ckey && Date.now() - _allAbs.at < 15 * 60 * 1000) return _allAbs.data;
  const [trips, vac] = await Promise.all([
    spActive(now, { reName: /командиров/i, key: 'trip_all', kind: 'trip',
      reDomain: /команди?ровк/i, reDead: /провал|fail|отклон|не\s*состоя/i, all: true, window: win }),
    spActive(now, { reName: /отпуск/i, key: 'vac_all', kind: 'vacation',
      reDomain: /отпуск/i, reDead: /провал|fail|отклон|не\s*состоя/i, all: true, window: win }),
  ]);
  try {
    const ids = [...new Set(trips.map(t => t.companyId).filter(Boolean))];
    if (ids.length) {
      const r = await b24('crm.company.list', { filter: { '@ID': ids }, select: ['ID', 'TITLE'] });
      const comp = {}; for (const c of (r && r.result) || []) comp[String(c.ID)] = c.TITLE;
      for (const t of trips) { const nm = comp[String(t.companyId)]; if (nm) t.dest = (t.dest ? t.dest + ' · ' : '') + nm; }
    }
  } catch (e) { /* компании не критичны */ }
  const data = trips.concat(vac);
  _allAbs = { at: Date.now(), key: ckey, data };
  return data;
}
// Дебаг обоих смарт-процессов для сверки полей/этапов.
async function tripsDebug() {
  const dbg = async (reName, reStage, reDomain) => {
    const etid = await spTypeId(reName, 'dbg_' + reName.source);
    let sample = null, count = 0, stages = [], matchStages = [];
    if (etid) {
      try { let start = 0, g = 0; while (g++ < 20) { const r = await b24('crm.status.list', { start });
        for (const s of (r && r.result) || []) { if (String(s.ENTITY_ID || '').indexOf('DYNAMIC_' + etid + '_') === -1) continue;
          stages.push({ id: s.STATUS_ID, name: s.NAME }); if (reStage && reStage.test(s.NAME || '')) matchStages.push(s.STATUS_ID); }
        const n = r && r.next; if (n == null) break; start = n; } } catch (e) {}
      try { const r = await b24('crm.item.list', { entityTypeId: etid, select: ['*', 'uf_*'], order: { id: 'desc' }, start: 0 });
        const items = (r && r.result && r.result.items) || []; count = items.length; sample = items[0] || null; } catch (e) {}
    }
    // Найденные коды полей начала/окончания + их названия.
    let dateFields = { start: null, end: null, startTitle: '', endTitle: '' };
    if (etid) {
      try {
        const r = await b24('crm.item.fields', { entityTypeId: etid });
        const fields = (r && r.result && r.result.fields) || {};
        let sD=null,sDt='',sG=null,sGt='',eD=null,eDt='',eG=null,eGt='';
        for (const code in fields) { const f = fields[code] || {}; if (!/date/i.test(String(f.type || ''))) continue;
          const t = String(f.title || '').toLowerCase(); const dom = reDomain ? reDomain.test(t) : false;
          if (/нача/.test(t)) { if (dom) { if(!sD){sD=code;sDt=f.title;} } else if(!sG){sG=code;sGt=f.title;} }
          if (/оконч|конец/.test(t)) { if (dom) { if(!eD){eD=code;eDt=f.title;} } else if(!eG){eG=code;eGt=f.title;} } }
        dateFields = { start: sD||sG, end: eD||eG, startTitle: sD?sDt:sGt, endTitle: eD?eDt:eGt };
      } catch (e) {}
    }
    return { entityTypeId: etid, count, matchStages, stages, dateFields, sample };
  };
  let types = [];
  try { const tl = await b24('crm.type.list', {}); types = ((tl && tl.result && tl.result.types) || []).map(t => ({ id: t.entityTypeId, title: t.title })); } catch (e) {}
  return { types,
    trips: await dbg(/командиров/i, /^в\s+команди?ровк/i, /команди?ровк/i),
    vacations: await dbg(/отпуск/i, /^отпуск$/i, /отпуск/i) };
}

async function build(pool, now) {
  now = now || new Date();
  const res = { date: { d: now.getDate(), m: now.getMonth() + 1 },
    birthdays: birthdays(now), onThisDay: [], absences: [], pulse: {}, fact: {} };
  const [otd, pls, absM, smart] = await Promise.allSettled([
    onThisDay(now), pulse(now), absencesToday(pool, now), smartAbsences(now)]);
  if (otd.status === 'fulfilled') res.onThisDay = otd.value;
  if (pls.status === 'fulfilled') res.pulse = pls.value;
  let abs = (absM.status === 'fulfilled' && absM.value) ? absM.value : [];
  if (smart.status === 'fulfilled' && smart.value) abs = abs.concat(smart.value);
  res.absences = abs;
  // «Факт дня»: живая сводка + ИИ-вывод (кэш на день, генерится в фоне) + резервный факт.
  const ctx = { inWork: res.pulse.inWork, closedMonth: res.pulse.closedMonth, leadsToday: res.pulse.leadsToday,
    absent: (res.absences || []).map(a => ({ name: a.name, kind: a.kind, dest: a.dest })),
    birthdaysToday: (res.birthdays.today || []), topDeal: res.onThisDay[0] || null };
  res.fact = { insight: dayInsight(res.pulse, res.absences), ai: aiDigest(now, ctx), tip: dailyFact(now), aiState: aiState() };
  return res;
}

module.exports = { build, birthdays, onThisDay, pulse, dailyFact, smartAbsences, allAbsences, tripsDebug, BIRTHDAYS };

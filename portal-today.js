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
  _sp[key] = { at: Date.now(), id, stages: null, stageKey: '' };
  return id;
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
    const r = await b24('crm.item.list', { entityTypeId: etid, order: { id: 'desc' }, start: 0 });
    const items = (r && r.result && r.result.items) || [];
    for (const it of items.slice(0, 150)) {
      const dates = [];
      for (const k in it) { if (/creat|updat|mov|activ|communicat/i.test(k)) continue;
        const d = _pdate(it[k]); if (d) dates.push(d); }
      dates.sort();
      const from = dates[0] || '', to = dates[dates.length - 1] || '';
      // Показываем ТОЛЬКО если даты активны сегодня (from ≤ today ≤ to). Этап
      // «В командировке», если определился, дополнительно сужает выборку.
      const dateActive = !!(from && from <= todayISO && (!to || todayISO <= to));
      let include = dateActive;
      if (opts.reStage && stageIds.size) include = include && stageIds.has(String(it.stageId));
      if (!include) continue;
      const who = USERS[String(it.assignedById)] || '';
      out.push({ name: who || it.title || 'Сотрудник', kind: opts.kind,
        from_date: from, to_date: to, dest: (opts.kind === 'trip' && who && it.title) ? String(it.title) : '' });
    }
  } catch (e) { /* процесс недоступен */ }
  return out;
}
let _smart = { at: 0, data: null };
async function smartAbsences(now) {
  now = now || new Date();
  if (_smart.data && Date.now() - _smart.at < 15 * 60 * 1000) return _smart.data;
  const [trips, vac] = await Promise.all([
    spActive(now, { reName: /командиров/i, key: 'trip', kind: 'trip', reStage: /команди?ровк/i }),
    spActive(now, { reName: /отпуск/i, key: 'vac', kind: 'vacation' }),
  ]);
  const data = trips.concat(vac);
  _smart = { at: Date.now(), data };
  return data;
}
// Дебаг обоих смарт-процессов для сверки полей/этапов.
async function tripsDebug() {
  const dbg = async (reName, reStage) => {
    const etid = await spTypeId(reName, 'dbg_' + reName.source);
    let sample = null, count = 0, stages = [], matchStages = [];
    if (etid) {
      try { let start = 0, g = 0; while (g++ < 20) { const r = await b24('crm.status.list', { start });
        for (const s of (r && r.result) || []) { if (String(s.ENTITY_ID || '').indexOf('DYNAMIC_' + etid + '_') === -1) continue;
          stages.push({ id: s.STATUS_ID, name: s.NAME }); if (reStage && reStage.test(s.NAME || '')) matchStages.push(s.STATUS_ID); }
        const n = r && r.next; if (n == null) break; start = n; } } catch (e) {}
      try { const r = await b24('crm.item.list', { entityTypeId: etid, order: { id: 'desc' }, start: 0 });
        const items = (r && r.result && r.result.items) || []; count = items.length; sample = items[0] || null; } catch (e) {}
    }
    return { entityTypeId: etid, count, matchStages, stages, sample };
  };
  let types = [];
  try { const tl = await b24('crm.type.list', {}); types = ((tl && tl.result && tl.result.types) || []).map(t => ({ id: t.entityTypeId, title: t.title })); } catch (e) {}
  return { types, trips: await dbg(/командиров/i, /команди?ровк/i), vacations: await dbg(/отпуск/i, null) };
}

async function build(pool, now) {
  now = now || new Date();
  const res = { date: { d: now.getDate(), m: now.getMonth() + 1 },
    birthdays: birthdays(now), onThisDay: [], absences: [], pulse: {}, fact: dailyFact(now) };
  const [otd, pls, absM, smart] = await Promise.allSettled([
    onThisDay(now), pulse(now), absencesToday(pool, now), smartAbsences(now)]);
  if (otd.status === 'fulfilled') res.onThisDay = otd.value;
  if (pls.status === 'fulfilled') res.pulse = pls.value;
  let abs = (absM.status === 'fulfilled' && absM.value) ? absM.value : [];
  if (smart.status === 'fulfilled' && smart.value) abs = abs.concat(smart.value);
  res.absences = abs;
  return res;
}

module.exports = { build, birthdays, onThisDay, pulse, dailyFact, smartAbsences, tripsDebug, BIRTHDAYS };

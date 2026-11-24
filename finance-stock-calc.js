// Модуль «Склад» (остатки на складах). Источник — 1С (fact_stock), пока не готова —
// мок-данные. Данные кэшируются в ticketsmodule_onec_stock; страница отдаёт кэш,
// кнопка «Обновить» пересобирает. Реальные данные — правим ТОЛЬКО fetchStockRaw().
const { pool } = require('./auth');
const onecMod = require('./onec');

// Как в Power BI: показываем остаток по складскому счёту (1330) и по складам
// (по умолчанию — Основной). Оба — через env, чтобы менять без правок кода.
//   ONEC_STOCK_ACCOUNTS — счёт(а) учёта остатка, по умолчанию 1330 (можно "1330,1310").
//   ONEC_STOCK_STORE    — store_id «Основного склада» (предвыбор фильтра «Склад»).
const STOCK_ACCOUNTS = (process.env.ONEC_STOCK_ACCOUNTS || '1330').split(',').map(s => s.trim()).filter(Boolean);
const STOCK_MAIN_STORE = (process.env.ONEC_STOCK_STORE || '30fbc59e-20f3-11eb-1381-fa163eef77d8').trim();
// Человеческие имена складов по store_id. 1С отдаёт только GUID, поэтому карту имён
// задаём через env ONEC_STORE_NAMES (JSON: {"<guid>":"Склад запчастей", ...}).
// Как только 1С начнёт отдавать имя склада (поле Склад/store_name) — оно подхватится само.
let STORE_NAMES = {};
try { STORE_NAMES = JSON.parse(process.env.ONEC_STORE_NAMES || '{}') || {}; } catch (e) { STORE_NAMES = {}; }
function storeLabel(id, name) {
  if (!id) return name || '—';
  if (STORE_NAMES[id]) return STORE_NAMES[id];
  if (name && String(name).trim()) return String(name).trim();
  if (id === STOCK_MAIN_STORE) return 'Основной склад';
  return 'Склад ' + String(id).slice(0, 8);
}

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_stock (
        id VARCHAR(160) PRIMARY KEY,
        name VARCHAR(500),          -- Номенклатура (наименование)
        item_code VARCHAR(80),      -- НоменклатурныйНомер
        part_no VARCHAR(120),       -- SP_Партномер
        order_no VARCHAR(120),      -- SP_НомерЗаказа
        manufacturer VARCHAR(200),  -- SP_Производитель
        made_date DATE,             -- SP_ДатаИзготовления
        expiry DATE,                -- SP_СрокГодности
        qty NUMERIC DEFAULT 0,      -- Количество
        price NUMERIC DEFAULT 0,    -- Цена
        amount NUMERIC DEFAULT 0,   -- Сумма
        shelf VARCHAR(60),          -- SP_НомерПолки
        barcode VARCHAR(80),        -- Штрихкод
        gtd VARCHAR(120),           -- SP_НомерГТД
        account VARCHAR(40),        -- Счет
        store_id VARCHAR(60),
        store VARCHAR(160),         -- Склад (наименование, напр. «Основной склад»)
        synced_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE ticketsmodule_onec_stock ADD COLUMN IF NOT EXISTS store VARCHAR(160);
      CREATE INDEX IF NOT EXISTS idx_onec_stock_order ON ticketsmodule_onec_stock(order_no);
      CREATE INDEX IF NOT EXISTS idx_onec_stock_mfr ON ticketsmodule_onec_stock(manufacturer);
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_meta (
        source VARCHAR(40) PRIMARY KEY,
        last_sync TIMESTAMPTZ, last_ok_at TIMESTAMPTZ, last_error TEXT, is_mock BOOLEAN DEFAULT true);
      -- Реестр «неснижаемого запаса». Ключ — НоменклатурныйНомер (item_code): он стабилен
      -- и переживает пересинк, поэтому пометка «держим как неснижаемый» автоматически
      -- подхватывается на будущих выгрузках той же номенклатуры.
      CREATE TABLE IF NOT EXISTS ticketsmodule_stock_min (
        item_code VARCHAR(80) PRIMARY KEY,
        name VARCHAR(500),
        min_qty NUMERIC,
        note VARCHAR(300),
        added_by VARCHAR(80),
        added_at TIMESTAMPTZ DEFAULT NOW());
      -- Порог критического уровня в % от нормы (NULL → глобальные 30%) и состояние
      -- аларма, чтобы не слать уведомление повторно, пока остаток не поднимется выше.
      ALTER TABLE ticketsmodule_stock_min ADD COLUMN IF NOT EXISTS threshold_pct NUMERIC;
      ALTER TABLE ticketsmodule_stock_min ADD COLUMN IF NOT EXISTS alarm_below BOOLEAN DEFAULT false;
      ALTER TABLE ticketsmodule_stock_min ADD COLUMN IF NOT EXISTS last_alarm_at TIMESTAMPTZ;
      -- «Код» для группировки одинаковых физических позиций, заведённых под разными
      -- номенклатурными номерами. Реестр кодов (код → наименование + норма группы):
      CREATE TABLE IF NOT EXISTS ticketsmodule_stock_code_def (
        code VARCHAR(80) PRIMARY KEY,
        name VARCHAR(500),
        min_qty NUMERIC,
        threshold_pct NUMERIC,
        alarm_below BOOLEAN DEFAULT false,
        last_alarm_at TIMESTAMPTZ,
        added_by VARCHAR(80),
        added_at TIMESTAMPTZ DEFAULT NOW());
      -- Привязка позиции (item_code) к коду группы. Неснижаемый считается по сумме
      -- количества всех позиций одного кода.
      CREATE TABLE IF NOT EXISTS ticketsmodule_stock_code_map (
        item_code VARCHAR(80) PRIMARY KEY,
        code VARCHAR(80),
        set_by VARCHAR(80),
        set_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_stock_code_map_code ON ticketsmodule_stock_code_map(code);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Мок-данные (пока нет 1С) — форма как в PBI «Склад». ──────────────────────
function mockStock() {
  const ITEMS = [
    ['Кабель питания Wire Power Entrance для AUT320N', 'S.PARTS', 'Agilent'],
    ['Наконечник кольцевой НКИ 2,5-5 (КВТ)', '', 'КВТ'],
    ['Наконечник кольцевой НКИ 6,0-6 (КВТ)', '', 'КВТ'],
    ['Хомут металлический червячный 10-16, 9мм', '', 'Сибртех'],
    ['Наконечник медный Т 6-5-4 ЗЭТА', '', 'ЗЭТА'],
    ['Сальник PG21 д.15-18мм (гермет.ввод, пластик)', '', 'UNIT'],
    ['Вилка угловая с/з чёрн. 16A 250В EKF PROxima', '', 'EKF'],
    ['Рукав газовый I класс Ø6,3 ацетилен/пропан (красный, 40м)', '', 'GCE'],
    ['Рукав кислородный d=6.3 GCE KRASS PREMIUM синий', '', 'GCE'],
    ['Колонка Agilent ZORBAX Eclipse Plus C18', 'Z959', 'Agilent'],
    ['Лампа дейтериевая для ВЭЖХ-детектора', 'DL-01', 'Agilent'],
    ['Септа для инжектора GC 11мм (уп.50)', 'SEP50', 'Agilent'],
    ['Фильтр воды ELGA PURELAB', 'PL-F1', 'ELGA'],
    ['Электрод стеклянный pH Metrohm', 'MpH', 'Metrohm'],
    ['Тигель платиновый для элементного анализа', 'PT-10', 'LNI'],
  ];
  const ORDERS = ['ДО', '22', '4500226211', '61451010', '65706020', 'Spares-2026-167'];
  let seed = 11; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = [];
  ITEMS.forEach((it, i) => {
    const n = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const qty = 1 + Math.floor(rnd() * 99);
      const price = Math.round(20 + rnd() * 400);
      rows.push({
        id: `S-${i}-${k}`,
        name: it[0], part_no: it[1] || '', manufacturer: it[2] || '',
        order_no: ORDERS[Math.floor(rnd() * ORDERS.length)],
        item_code: '000000' + (10000 + i * 7 + k),
        made_date: null, expiry: null,
        qty, price, amount: qty * price,
        shelf: '0' + (200 + i) + '-' + (k + 1),
        barcode: '', gtd: '', account: '1330', store_id: 'MAIN', store: 'Основной склад',
      });
    }
  });
  return rows;
}

// Единая точка получения строк склада. Реальные данные 1С — таблица fact_stock:
//   date, Счет, SP_Партномер, SP_НомерЗаказа, НоменклатурныйНомер,
//   SP_ДатаИзготовления, SP_СрокГодности, Количество, Цена, Сумма, SP_НомерПолки,
//   Штрихкод, SP_Производитель, SP_НомерГТД, reference_id, store_id.
// «Номенклатура» (наименование) — из reference_id/поля названия; подгоним, когда
// 1С опубликует сервис.
async function fetchStockRaw() {
  if (!onecMod.isConfigured()) return mockStock();
  // Сервис fact/stock?date=YYYY-MM-DD — остаток на дату (по умолчанию сегодня). Ответ {count, items}.
  const date = new Date().toISOString().slice(0, 10);
  const data = await onecMod.onec('fact/stock', { date });
  const arr = Array.isArray(data) ? data : (data.items || data.rows || data.data || data.value || []);
  return arr.map((r, idx) => {
    const qty = Number(r.Количество ?? r.qty ?? 0);
    const price = Number(r.Цена ?? r.price ?? 0);
    return {
      id: String(r.reference_id ?? r.id ?? (r.НоменклатурныйНомер + '|' + (r.SP_НомерЗаказа || '') + '|' + idx)),
      // Наименование: в fact/stock его может не быть (тогда — пусто, подставим код в getStockBoard).
      // Пробуем все вероятные ключи, чтобы подхватить имя, как только 1С начнёт его отдавать.
      name: r.Номенклатура ?? r.Наименование ?? r.НоменклатураНаименование ?? r.НаименованиеНоменклатуры
            ?? r.НоменклатураНаим ?? r.Товар ?? r.name ?? r.nomenclature_name ?? r.reference_name ?? '',
      item_code: r.НоменклатурныйНомер ?? r.item_code ?? '',
      part_no: r.SP_Партномер ?? r.part_no ?? '',
      order_no: r.SP_НомерЗаказа ?? r.order_no ?? '',
      manufacturer: r.SP_Производитель ?? r.manufacturer ?? '',
      made_date: r.SP_ДатаИзготовления ?? null,
      expiry: r.SP_СрокГодности ?? null,
      qty, price,
      amount: Number(r.Сумма ?? r.amount ?? (qty * price)),
      shelf: r.SP_НомерПолки ?? '',
      barcode: r.Штрихкод ?? '',
      gtd: r.SP_НомерГТД ?? '',
      account: r.Счет ?? r.account ?? '',
      store_id: r.store_id ?? '',
      store: r.Склад ?? r.store_name ?? r.store ?? '',
    };
  });
}

async function syncStock() {
  await ensureSchema();
  const mock = !onecMod.isConfigured();
  try {
    const rows = await fetchStockRaw();
    await pool.query('DELETE FROM ticketsmodule_onec_stock');
    for (const r of rows) {
      await pool.query(
        `INSERT INTO ticketsmodule_onec_stock
           (id, name, item_code, part_no, order_no, manufacturer, made_date, expiry, qty, price, amount, shelf, barcode, gtd, account, store_id, store)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO UPDATE SET name=$2,item_code=$3,part_no=$4,order_no=$5,manufacturer=$6,made_date=$7,expiry=$8,qty=$9,price=$10,amount=$11,shelf=$12,barcode=$13,gtd=$14,account=$15,store_id=$16,store=$17,synced_at=NOW()`,
        [r.id, r.name || '', r.item_code || '', r.part_no || '', r.order_no || '', r.manufacturer || '',
         r.made_date || null, r.expiry || null, r.qty || 0, r.price || 0, r.amount || 0,
         r.shelf || '', r.barcode || '', r.gtd || '', r.account || '', r.store_id || '', r.store || '']);
    }
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_ok_at, is_mock, last_error)
       VALUES ('stock', NOW(), NOW(), $1, NULL)
       ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_ok_at=NOW(), is_mock=$1, last_error=NULL`, [mock]);
    // После обновления остатков — проверить неснижаемые на критический минимум (аларм).
    try { await checkStockAlarms(); } catch (e) { console.error('checkStockAlarms:', e.message); }
    return { ok: true, count: rows.length, mock };
  } catch (e) {
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_error, is_mock)
       VALUES ('stock', NOW(), $1, $2)
       ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_error=$1, is_mock=$2`,
      [String(e && e.message || e).slice(0, 300), mock]).catch(() => {});
    return { ok: false, error: String(e && e.message || e), mock };
  }
}

// ── Полоса обзора Склада: ABC/Парето, деньги по производителям, срок годности ──
function buildStockOverview(scopeRows, account, scopeLabel) {
  const amt = r => Number(r.amount || 0);
  const positions = scopeRows.length;
  const totalAmount = scopeRows.reduce((a, r) => a + amt(r), 0);
  const totalQty = scopeRows.reduce((a, r) => a + Number(r.qty || 0), 0);
  const doCount = scopeRows.filter(r => String(r.order_no || '').trim() === 'ДО').length;

  // ABC/Парето: агрегируем сумму по наименованию, топ-14 + хвост.
  const byName = {};
  for (const r of scopeRows) { const k = r.name || '—'; byName[k] = (byName[k] || 0) + amt(r); }
  const sortedN = Object.entries(byName).map(([name, amount]) => ({ name, amount: Math.round(amount) })).sort((a, b) => b.amount - a.amount);
  const grand = sortedN.reduce((s, x) => s + x.amount, 0) || 1;
  const topN = sortedN.slice(0, 14);
  const tail = sortedN.slice(14);
  const abc = { items: topN, tailCount: tail.length, tailSum: Math.round(tail.reduce((s, x) => s + x.amount, 0)), grand, topShare: Math.round(topN.reduce((s, x) => s + x.amount, 0) / grand * 100) };

  // Деньги по производителям: топ-7 + прочие.
  const byM = {};
  for (const r of scopeRows) { const k = r.manufacturer || '—'; byM[k] = (byM[k] || 0) + amt(r); }
  const sM = Object.entries(byM).map(([name, amount]) => ({ name, amount: Math.round(amount) })).sort((a, b) => b.amount - a.amount);
  const rest = sM.slice(7).reduce((s, x) => s + x.amount, 0);
  const mfr = sM.slice(0, 7).concat(rest > 0 ? [{ name: 'Прочие', amount: Math.round(rest) }] : []);

  // Срок годности: разбивка по дням до истечения + ближайшие к списанию.
  const today = new Date(), DAY = 86400000;
  const b = { le30: 0, le60: 0, le90: 0, gt90: 0, none: 0 };
  let hasExpiry = false; const soonArr = [];
  for (const r of scopeRows) {
    const v = amt(r); let placed = false;
    if (r.expiry) { const d = new Date(r.expiry); if (!isNaN(d)) { hasExpiry = true; const days = Math.round((d - today) / DAY);
      if (days <= 30) b.le30 += v; else if (days <= 60) b.le60 += v; else if (days <= 90) b.le90 += v; else b.gt90 += v;
      if (days <= 90) soonArr.push({ name: r.name, days, amount: Math.round(v) }); placed = true; } }
    if (!placed) b.none += v;
  }
  const aging = [
    { key: 'le30', label: '≤ 30 дн', value: Math.round(b.le30) },
    { key: 'le60', label: '31–60 дн', value: Math.round(b.le60) },
    { key: 'le90', label: '61–90 дн', value: Math.round(b.le90) },
    { key: 'gt90', label: '> 90 дн', value: Math.round(b.gt90) },
    { key: 'none', label: 'без срока', value: Math.round(b.none) },
  ];
  const atRisk = Math.round(b.le30 + b.le60 + b.le90);
  const soon = soonArr.sort((a, b) => a.days - b.days).slice(0, 6);

  return {
    scopeLabel, account,
    kpis: {
      positions, amount: Math.round(totalAmount), qty: totalQty, atRisk,
      atRiskShare: totalAmount > 0 ? atRisk / totalAmount : 0,
      doShare: positions > 0 ? doCount / positions : 0,
    },
    abc, mfr, aging, hasExpiry, soon,
  };
}

async function getStockBoard() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_onec_stock ORDER BY name, order_no');
  if (!rows.length) { await syncStock(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_onec_stock ORDER BY name, order_no')); }
  const meta = (await pool.query(`SELECT * FROM ticketsmodule_onec_meta WHERE source='stock'`)).rows[0] || {};
  // Реестр неснижаемого запаса (по item_code): флаг min + норма + порог %.
  const minRows = (await pool.query('SELECT item_code, min_qty, threshold_pct FROM ticketsmodule_stock_min')).rows;
  const minMap = new Map();
  for (const mr of minRows) minMap.set(String(mr.item_code || '').trim(), { q: mr.min_qty != null ? Number(mr.min_qty) : null, t: mr.threshold_pct != null ? Number(mr.threshold_pct) : null });
  // «Код» — группировка одинаковых позиций. Привязка item_code→code и реестр норм по коду.
  const codeMap = new Map();
  for (const cr of (await pool.query('SELECT item_code, code FROM ticketsmodule_stock_code_map')).rows) {
    const c = String(cr.code || '').trim(); if (c) codeMap.set(String(cr.item_code || '').trim(), c);
  }
  const codeDef = new Map();
  for (const dr of (await pool.query('SELECT code, name, min_qty, threshold_pct FROM ticketsmodule_stock_code_def')).rows) {
    codeDef.set(String(dr.code || '').trim(), { name: dr.name || '', q: dr.min_qty != null ? Number(dr.min_qty) : null, t: dr.threshold_pct != null ? Number(dr.threshold_pct) : null });
  }
  const groupOf = r => { const c = codeMap.get(String(r.item_code || '').trim()); return (c && codeDef.has(c)) ? c : null; };
  const isMin = r => groupOf(r) != null || minMap.has(String(r.item_code || '').trim());

  // Счёт 1330 — как в Power BI (бизнес-правило). Безопасный откат: если в кэше счёт
  // не заполнен (фильтр обнулил бы всё) — показываем без него, не прячем данные.
  let base = rows;
  if (STOCK_ACCOUNTS.length) {
    const f = rows.filter(r => STOCK_ACCOUNTS.includes(String(r.account || '').trim()));
    if (f.length) base = f;
  }
  // Суммарный остаток по номенклатуре (для признака «критический минимум»):
  // норма/порог заданы на item_code, а в выборке позиция может быть по нескольким складам.
  const codeTotal = new Map();
  for (const r of base) { const c = String(r.item_code || '').trim(); codeTotal.set(c, (codeTotal.get(c) || 0) + Number(r.qty || 0)); }
  // Суммарный остаток по ГРУППЕ (коду) — для неснижаемого по сумме одинаковых позиций.
  const groupTotal = new Map();
  for (const r of base) { const g = groupOf(r); if (g) groupTotal.set(g, (groupTotal.get(g) || 0) + Number(r.qty || 0)); }
  const GLOBAL_PCT = 30;
  const minMeta = r => {
    const code = codeMap.get(String(r.item_code || '').trim()) || '';
    const g = groupOf(r);
    if (g) {
      const def = codeDef.get(g);
      const gq = groupTotal.get(g) || 0;
      const critical = def.q != null && def.q > 0 && gq <= Number(def.q) * (def.t != null ? def.t : GLOBAL_PCT) / 100;
      return { minQty: def.q, thresholdPct: def.t, critical, code, groupQty: gq };
    }
    const c = String(r.item_code || '').trim(); const mm = minMap.get(c);
    if (!mm) return { minQty: null, thresholdPct: null, critical: false, code };
    const critical = mm.q != null && mm.q > 0 && (codeTotal.get(c) || 0) <= Number(mm.q) * (mm.t != null ? mm.t : GLOBAL_PCT) / 100;
    return { minQty: mm.q, thresholdPct: mm.t, critical, code };
  };
  // Склады по store_id (из строк, отфильтрованных по счёту) — для фильтра «Склад».
  const storeMap = new Map();
  for (const r of base) {
    const id = String(r.store_id || '');
    if (!storeMap.has(id)) storeMap.set(id, { id, name: storeLabel(id, r.store), qty: 0, amount: 0 });
    const s = storeMap.get(id); s.qty += Number(r.qty || 0); s.amount += Number(r.amount || 0);
  }
  const stores = [...storeMap.values()].sort((a, b) => b.amount - a.amount);
  const defaultStore = stores.some(s => s.id === STOCK_MAIN_STORE) ? STOCK_MAIN_STORE : '';
  const uniq = f => [...new Set(base.map(r => r[f]).filter(Boolean))].sort();

  // Обзор считаем по области по умолчанию (Основной склад, если есть), иначе по всему счёту.
  const scopeRows = defaultStore ? base.filter(r => String(r.store_id || '') === defaultStore) : base;
  const scopeLabel = (defaultStore ? storeLabel(defaultStore, '') : 'все склады') + ', счёт ' + STOCK_ACCOUNTS.join(',');
  const overview = buildStockOverview(scopeRows, STOCK_ACCOUNTS.join(','), scopeLabel);

  return {
    overview,
    rows: base.map(r => ({
      // Наименование: если 1С имя не отдала — показываем НоменклатурныйНомер, чтобы строка не была пустой.
      id: r.id, name: r.name || r.item_code || '', item_code: r.item_code, part_no: r.part_no, order_no: r.order_no,
      manufacturer: r.manufacturer, made_date: r.made_date, expiry: r.expiry,
      qty: Number(r.qty || 0), price: Number(r.price || 0), amount: Number(r.amount || 0),
      shelf: r.shelf, barcode: r.barcode, gtd: r.gtd, min: isMin(r), ...minMeta(r),
      account: r.account || '', store_id: String(r.store_id || ''), store: storeLabel(String(r.store_id || ''), r.store),
    })),
    totals: { qty: base.reduce((a, r) => a + Number(r.qty || 0), 0), amount: base.reduce((a, r) => a + Number(r.amount || 0), 0) },
    minCount: base.filter(isMin).length, nameFromCode: base.every(r => !r.name),
    asOf: meta.last_ok_at || null, lastTry: meta.last_sync || null, mock: meta.is_mock !== false, error: meta.last_error || null,
    account: STOCK_ACCOUNTS.join(','), defaultStore,
    filters: { orders: uniq('order_no'), manufacturers: uniq('manufacturer'), stores },
  };
}

// ── Реестр неснижаемого запаса (ведём в ЦУП, ключ — item_code) ───────────────
async function listMinStock() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT item_code, name, min_qty, note, threshold_pct, alarm_below, last_alarm_at, added_by, added_at FROM ticketsmodule_stock_min ORDER BY name, item_code');
  return rows;
}
// Отметить/снять позицию как неснижаемый запас. on=false — удалить из реестра.
async function setMinStock(itemCode, on, meta, by) {
  await ensureSchema();
  itemCode = String(itemCode == null ? '' : itemCode).trim();
  if (!itemCode) throw new Error('пустой номенклатурный номер');
  meta = meta || {};
  if (on === false) { await pool.query('DELETE FROM ticketsmodule_stock_min WHERE item_code=$1', [itemCode]); return { ok: true, item_code: itemCode, min: false }; }
  await pool.query(
    `INSERT INTO ticketsmodule_stock_min (item_code, name, min_qty, note, threshold_pct, added_by, added_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (item_code) DO UPDATE SET
       name=COALESCE(EXCLUDED.name, ticketsmodule_stock_min.name),
       min_qty=COALESCE(EXCLUDED.min_qty, ticketsmodule_stock_min.min_qty),
       note=COALESCE(EXCLUDED.note, ticketsmodule_stock_min.note),
       threshold_pct=COALESCE(EXCLUDED.threshold_pct, ticketsmodule_stock_min.threshold_pct)`,
    [itemCode, meta.name || null, (meta.minQty != null && meta.minQty !== '') ? Number(meta.minQty) : null, meta.note || null,
     (meta.thresholdPct != null && meta.thresholdPct !== '') ? Number(meta.thresholdPct) : null, by || null]);
  return { ok: true, item_code: itemCode, min: true };
}
// Массовая отметка по списку кодов (разовый список от кладовщика).
async function bulkMinStock(codes, by) {
  await ensureSchema();
  const list = (Array.isArray(codes) ? codes : String(codes || '').split(/[\s,;\n]+/))
    .map(c => String(c || '').trim()).filter(Boolean);
  let n = 0;
  for (const code of [...new Set(list)]) { await setMinStock(code, true, {}, by); n++; }
  return { ok: true, added: n };
}

// ── Диагностика: сырые ключи/значения из ответа 1С fact/stock (только админ) ──
// Разовая проба — увидеть, под каким полем 1С отдаёт наименование (если отдаёт).
async function probeStockRaw(limit) {
  if (!onecMod.isConfigured()) return { configured: false, note: '1С не настроена (мок-режим)', sample: [] };
  const date = new Date().toISOString().slice(0, 10);
  const data = await onecMod.onec('fact/stock', { date });
  const arr = Array.isArray(data) ? data : (data.items || data.rows || data.data || data.value || []);
  const n = Math.max(1, Math.min(Number(limit) || 3, 10));
  const keys = arr.length ? Object.keys(arr[0]) : [];
  return { configured: true, count: arr.length, keys, sample: arr.slice(0, n) };
}

// ── Аларм по неснижаемому запасу ────────────────────────────────────────────
// При падении остатка до критического уровня (по умолчанию 30% от нормы, можно
// переопределить threshold_pct на позиции) — одно уведомление менеджеру склада
// (почта + Telegram + ЦУП-пуш). Повторно не шлём, пока остаток не поднимется выше.
const GLOBAL_THRESHOLD_PCT = 30;
const STORE_MANAGER_EMAIL = process.env.STORE_MANAGER_EMAIL || 'techsupport@prolabsupport.kz';
const _esc = s => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

async function currentQtyByCode() {
  const { rows } = await pool.query(
    "SELECT item_code, SUM(qty)::numeric AS qty, MAX(name) AS name FROM ticketsmodule_onec_stock WHERE item_code <> '' GROUP BY item_code");
  const m = new Map();
  for (const r of rows) m.set(String(r.item_code), { qty: Number(r.qty) || 0, name: r.name || '' });
  return m;
}

async function notifyLowStock(it) {
  const title = it.name || it.code;
  const subj = `🚨 Склад: критический минимум — ${title}`;
  const line = `Остаток ${it.qty} из нормы ${it.norm} (порог ${it.pct}% ≈ ${Math.round(it.threshold * 100) / 100}). Нужно заказать.`;
  const html = `<p><b>${_esc(title)}</b> (ном. ${_esc(it.code)})</p><p>${_esc(line)}</p><p style="color:#6a7488;font-size:12px">ProLabSupport · ЦУП · Склад</p>`;
  let notif = null; try { notif = require('./notifications'); } catch (e) {}
  // Почта
  try { if (notif && notif.sendEmailTo) await notif.sendEmailTo(STORE_MANAGER_EMAIL, subj, html); }
  catch (e) { console.error('stock alarm email:', e.message); }
  // Telegram + ЦУП-пуш менеджеру склада (ищем пользователя по email)
  try {
    const { rows } = await pool.query('SELECT id, bitrix_user_id FROM ticketsmodule_users WHERE lower(email)=lower($1) AND active=true LIMIT 1', [STORE_MANAGER_EMAIL]);
    const u = rows[0];
    if (u && u.bitrix_user_id) {
      const tl = await pool.query('SELECT telegram_chat_id FROM ticketsmodule_telegram_links WHERE bitrix_user_id=$1', [u.bitrix_user_id]);
      const chat = tl.rows[0] && tl.rows[0].telegram_chat_id;
      if (chat && notif && notif.tgTo) await notif.tgTo(String(chat), `🚨 Склад — критический минимум\n${title}\n${line}`).catch(() => {});
      try { const push = require('./push'); if (push.sendToUser) await push.sendToUser(u.bitrix_user_id, { type: 'alert', notify: { title: '🚨 Критический минимум на складе', body: `${title}: остаток ${it.qty} из ${it.norm}` }, url: '/finance-stock.html' }).catch(() => {}); } catch (e) {}
    }
  } catch (e) { console.error('stock alarm tg/push:', e.message); }
}

async function checkStockAlarms() {
  await ensureSchema();
  const { rows: mins } = await pool.query(
    'SELECT item_code, name, min_qty, threshold_pct, alarm_below FROM ticketsmodule_stock_min WHERE min_qty IS NOT NULL AND min_qty > 0');
  const qmap = await currentQtyByCode();
  let alarms = 0;
  for (const m of mins) {
    const cur = qmap.get(String(m.item_code)) || { qty: 0, name: m.name };
    const pct = (m.threshold_pct != null && m.threshold_pct !== '') ? Number(m.threshold_pct) : GLOBAL_THRESHOLD_PCT;
    const threshold = Number(m.min_qty) * pct / 100;
    const below = cur.qty <= threshold;
    if (below && !m.alarm_below) {
      try { await notifyLowStock({ code: m.item_code, name: m.name || cur.name, qty: cur.qty, norm: Number(m.min_qty), pct, threshold }); } catch (e) { console.error('notifyLowStock:', e.message); }
      await pool.query('UPDATE ticketsmodule_stock_min SET alarm_below=true, last_alarm_at=NOW() WHERE item_code=$1', [m.item_code]);
      alarms++;
    } else if (!below && m.alarm_below) {
      await pool.query('UPDATE ticketsmodule_stock_min SET alarm_below=false WHERE item_code=$1', [m.item_code]);
    }
  }
  // Группы по «Коду»: аларм по СУММЕ количества всех позиций кода.
  const { rows: defs } = await pool.query(
    'SELECT code, name, min_qty, threshold_pct, alarm_below FROM ticketsmodule_stock_code_def WHERE min_qty IS NOT NULL AND min_qty > 0');
  if (defs.length) {
    const { rows: maps } = await pool.query("SELECT item_code, code FROM ticketsmodule_stock_code_map WHERE code <> ''");
    const byCode = new Map();
    for (const mp of maps) { const c = String(mp.code).trim(); if (!byCode.has(c)) byCode.set(c, []); byCode.get(c).push(String(mp.item_code)); }
    for (const d of defs) {
      const members = byCode.get(String(d.code).trim()) || [];
      let gq = 0; for (const ic of members) gq += (qmap.get(ic) || { qty: 0 }).qty;
      const pct = (d.threshold_pct != null && d.threshold_pct !== '') ? Number(d.threshold_pct) : GLOBAL_THRESHOLD_PCT;
      const threshold = Number(d.min_qty) * pct / 100;
      const below = gq <= threshold;
      if (below && !d.alarm_below) {
        try { await notifyLowStock({ code: d.code, name: d.name || ('группа ' + d.code), qty: gq, norm: Number(d.min_qty), pct, threshold }); } catch (e) { console.error('notifyLowStock group:', e.message); }
        await pool.query('UPDATE ticketsmodule_stock_code_def SET alarm_below=true, last_alarm_at=NOW() WHERE code=$1', [d.code]);
        alarms++;
      } else if (!below && d.alarm_below) {
        await pool.query('UPDATE ticketsmodule_stock_code_def SET alarm_below=false WHERE code=$1', [d.code]);
      }
    }
  }
  if (alarms) console.log(`Stock alarms: ${alarms} позиций/групп ниже критического уровня`);
  return { checked: mins.length + defs.length, alarms };
}

// ── Коды групп (одинаковые позиции под разными номерами) ─────────────────────
async function listCodes() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT d.code, d.name, d.min_qty, d.threshold_pct, d.added_by, d.added_at,
            (SELECT COUNT(*) FROM ticketsmodule_stock_code_map m WHERE m.code=d.code) AS items
       FROM ticketsmodule_stock_code_def d ORDER BY d.name NULLS LAST, d.code`);
  return rows;
}
// Создать/изменить код группы (норма — на всю группу).
async function upsertCode(code, meta, by) {
  await ensureSchema();
  code = String(code == null ? '' : code).trim();
  if (!code) throw new Error('пустой код');
  meta = meta || {};
  await pool.query(
    `INSERT INTO ticketsmodule_stock_code_def (code, name, min_qty, threshold_pct, added_by, added_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (code) DO UPDATE SET
       name=COALESCE(EXCLUDED.name, ticketsmodule_stock_code_def.name),
       min_qty=COALESCE(EXCLUDED.min_qty, ticketsmodule_stock_code_def.min_qty),
       threshold_pct=COALESCE(EXCLUDED.threshold_pct, ticketsmodule_stock_code_def.threshold_pct)`,
    [code, meta.name || null,
     (meta.minQty != null && meta.minQty !== '') ? Number(meta.minQty) : null,
     (meta.thresholdPct != null && meta.thresholdPct !== '') ? Number(meta.thresholdPct) : null, by || null]);
  return { ok: true, code };
}
// Удалить код группы (привязки позиций к нему тоже снимаем).
async function deleteCode(code) {
  await ensureSchema();
  code = String(code == null ? '' : code).trim();
  await pool.query('DELETE FROM ticketsmodule_stock_code_def WHERE code=$1', [code]);
  await pool.query('DELETE FROM ticketsmodule_stock_code_map WHERE code=$1', [code]);
  return { ok: true, code };
}
// Привязать позицию (item_code) к коду; пустой code — снять привязку.
async function assignItemCode(itemCode, code, by) {
  await ensureSchema();
  itemCode = String(itemCode == null ? '' : itemCode).trim();
  if (!itemCode) throw new Error('пустой номенклатурный номер');
  code = String(code == null ? '' : code).trim();
  if (!code) { await pool.query('DELETE FROM ticketsmodule_stock_code_map WHERE item_code=$1', [itemCode]); return { ok: true, item_code: itemCode, code: '' }; }
  await pool.query(
    `INSERT INTO ticketsmodule_stock_code_map (item_code, code, set_by, set_at) VALUES ($1,$2,$3,NOW())
     ON CONFLICT (item_code) DO UPDATE SET code=EXCLUDED.code, set_by=EXCLUDED.set_by, set_at=NOW()`,
    [itemCode, code, by || null]);
  return { ok: true, item_code: itemCode, code };
}

module.exports = { ensureSchema, syncStock, getStockBoard, listMinStock, setMinStock, bulkMinStock, probeStockRaw, checkStockAlarms, listCodes, upsertCode, deleteCode, assignItemCode };

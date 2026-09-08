// Модуль «Склад» (остатки на складах). Источник — 1С (fact_stock), пока не готова —
// мок-данные. Данные кэшируются в ticketsmodule_onec_stock; страница отдаёт кэш,
// кнопка «Обновить» пересобирает. Реальные данные — правим ТОЛЬКО fetchStockRaw().
const { pool } = require('./auth');
const onecMod = require('./onec');

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
  const data = await onecMod.onec('fact_stock');
  const arr = Array.isArray(data) ? data : (data.rows || data.data || data.value || []);
  return arr.map((r, idx) => {
    const qty = Number(r.Количество ?? r.qty ?? 0);
    const price = Number(r.Цена ?? r.price ?? 0);
    return {
      id: String(r.reference_id ?? r.id ?? (r.НоменклатурныйНомер + '|' + (r.SP_НомерЗаказа || '') + '|' + idx)),
      name: r.Номенклатура ?? r.name ?? r.НоменклатурныйНомер ?? '',
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

async function getStockBoard() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_onec_stock ORDER BY name, order_no');
  if (!rows.length) { await syncStock(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_onec_stock ORDER BY name, order_no')); }
  const meta = (await pool.query(`SELECT * FROM ticketsmodule_onec_meta WHERE source='stock'`)).rows[0] || {};
  const uniq = f => [...new Set(rows.map(r => r[f]).filter(Boolean))].sort();
  return {
    rows: rows.map(r => ({
      id: r.id, name: r.name, item_code: r.item_code, part_no: r.part_no, order_no: r.order_no,
      manufacturer: r.manufacturer, made_date: r.made_date, expiry: r.expiry,
      qty: Number(r.qty || 0), price: Number(r.price || 0), amount: Number(r.amount || 0),
      shelf: r.shelf, barcode: r.barcode, gtd: r.gtd, store_id: r.store_id, store: r.store,
    })),
    totals: { qty: rows.reduce((a, r) => a + Number(r.qty || 0), 0), amount: rows.reduce((a, r) => a + Number(r.amount || 0), 0) },
    asOf: meta.last_sync || null, mock: meta.is_mock !== false, error: meta.last_error || null,
    filters: { orders: uniq('order_no'), manufacturers: uniq('manufacturer'), stores: uniq('store') },
  };
}

module.exports = { ensureSchema, syncStock, getStockBoard };

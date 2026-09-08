// Модуль «Качество» — сверка контрактов 1С ↔ сделок Битрикса по ключу
// bitrix_deal_id (поле «ID сделки» в договоре 1С). Находит одинаковые контракты
// и подсвечивает расхождения (сумма, наименование, отдел), а также «сироты»
// (есть только в 1С / только в Битриксе) и договоры без привязки.
//
// Источники:
//   • 1С  — dim_contract + dim_contractor (когда onec настроена), иначе мок.
//   • Б24 — зеркало сделок в нашей БД (подключим при реальных данных), иначе мок.
// Пока источники не готовы — весь модуль работает на демо-данных (mock=true).
const { pool } = require('./auth');
const onecMod = require('./onec');

const SUM_TOLERANCE = Number(process.env.QUALITY_SUM_TOLERANCE || 1); // ₸, порог различия сумм

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_quality (
        id VARCHAR(120) PRIMARY KEY,
        deal_id VARCHAR(40),
        status VARCHAR(20),            -- ok | diff | only_1c | only_b24 | no_link
        contractor VARCHAR(400),
        name_1c VARCHAR(500),
        name_b24 VARCHAR(500),
        sum_1c NUMERIC,
        sum_b24 NUMERIC,
        dept_1c VARCHAR(120),
        dept_b24 VARCHAR(120),
        diff_fields VARCHAR(200),
        synced_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_onec_quality_status ON ticketsmodule_onec_quality(status);
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_meta (
        source VARCHAR(40) PRIMARY KEY,
        last_sync TIMESTAMPTZ, last_ok_at TIMESTAMPTZ, last_error TEXT, is_mock BOOLEAN DEFAULT true);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Мок-источники (пока нет реальных данных) ─────────────────────────────────
function mock1C() {
  return [
    { deal_id: '2001', contractor: 'NFC Kazakhstan ТОО', name: 'ДОГОВОР ПОСТАВКИ №Inst-1001/2026', sum: 12500000, dept: 'Элементный' },
    { deal_id: '2004', contractor: 'Qazaq Kaolin ТОО', name: 'ДОГОВОР ПОСТАВКИ №Inst-1004/2026', sum: 4191763, dept: 'Хроматография' },
    { deal_id: '2007', contractor: 'ИЯФ РГП на ПХВ', name: 'Договор о закупках товаров №49', sum: 50006700, dept: 'Элементный' },
    { deal_id: '2010', contractor: 'BMT Holding Limited', name: 'ДОГОВОР ПОСТАВКИ №Inst-08122025-124', sum: 27737242, dept: 'Элементный' },
    { deal_id: '2013', contractor: 'ЖАНАЛАБ ТОО', name: 'ДОГОВОР №ЖАНА 2(03-1-0013)', sum: 2920300, dept: 'Электрохимия' },
    { deal_id: '2016', contractor: 'БОЗШАКОЛЬ', name: 'ДОГОВОР ПОСТАВКИ №01-2-00-05570-26', sum: 26100000, dept: 'Service' },
    { deal_id: '2019', contractor: 'НИЦ Уголь', name: 'ДОГОВОР ПОСТАВКИ №Inst-2026-51', sum: 29470530, dept: 'Training' },
    { deal_id: '', contractor: 'Astana BioTest', name: 'Договор без ID сделки', sum: 1500000, dept: 'Элементный' }, // нет связи
    { deal_id: '2099', contractor: 'Tenge Lab ТОО', name: 'Контракт есть только в 1С', sum: 8800000, dept: 'Service' }, // сироты 1С
  ];
}
function mockB24() {
  return [
    { deal_id: '2001', title: 'NFC Kazakhstan — Inst-1001', sum: 12500000, dept: 'Элементный' },      // ok
    { deal_id: '2004', title: 'Qazaq Kaolin — Inst-1004', sum: 4200000, dept: 'Хроматография' },        // diff: сумма
    { deal_id: '2007', title: 'ИЯФ — закупка №49', sum: 50006700, dept: 'Электрохимия' },               // diff: наимен.+отдел
    { deal_id: '2010', title: 'BMT Holding — Inst-08122025-124', sum: 27737242, dept: 'Элементный' },   // ok
    { deal_id: '2013', title: 'ЖАНАЛАБ 2(03-1-0013)', sum: 2920300, dept: 'Электрохимия' },             // ok
    { deal_id: '2016', title: 'БОЗШАКОЛЬ — 05570-26', sum: 25900000, dept: 'Service' },                 // diff: сумма
    { deal_id: '2019', title: 'НИЦ Уголь — Inst-2026-51', sum: 29470530, dept: 'Training' },            // ok
    { deal_id: '3050', title: 'Сделка есть только в Битриксе', sum: 6300000, dept: 'Хроматография' },   // сироты Б24
  ];
}

// TODO(1С/Б24): заменить на реальные источники.
async function fetch1CContracts() {
  if (!onecMod.isConfigured()) return mock1C();
  const [c, cr] = await Promise.all([onecMod.onec('dim_contract'), onecMod.onec('dim_contractor')]);
  const asArr = d => Array.isArray(d) ? d : (d && (d.rows || d.data || d.value)) || [];
  const nameById = {}; asArr(cr).forEach(x => nameById[String(x.contractor_id ?? x.Contractor_id)] = x.Name || '');
  return asArr(c).map(x => ({
    deal_id: String(x.IDСделки ?? x.БитриксСделка ?? x.bitrix_deal_id ?? (process.env.ONEC_CONTRACT_DEAL_FIELD ? x[process.env.ONEC_CONTRACT_DEAL_FIELD] : '') ?? '').trim(),
    contractor: nameById[String(x.contractor_id ?? x.Contractor_id)] || '',
    name: x.Name || '',
    sum: Number(x.СуммаДоговора ?? x.contract_sum ?? 0),
    dept: x.ОтветственныйОтдел ?? x.department ?? '',
  }));
}
// Сделки Битрикса берём из уже существующего зеркала сделок в нашей БД. Подключим
// конкретную таблицу/поля при реальных данных (напр. ticketsmodule_stats_deals).
async function fetchBitrixDeals() {
  if (!onecMod.isConfigured()) return mockB24();
  // TODO(Б24): SELECT из зеркала сделок с полями { deal_id, title, sum, dept }.
  return [];
}

function buildPairs(list1c, listB24) {
  const b24 = {}; for (const d of listB24) if (d.deal_id) b24[String(d.deal_id)] = d;
  const seenB24 = new Set();
  const rows = [];
  for (const c of list1c) {
    const id = String(c.deal_id || '').trim();
    if (!id) { rows.push({ id: 'nolink-' + c.name, deal_id: '', status: 'no_link', contractor: c.contractor, name_1c: c.name, name_b24: '', sum_1c: c.sum, sum_b24: null, dept_1c: c.dept, dept_b24: '', diff_fields: '' }); continue; }
    const d = b24[id];
    if (!d) { rows.push({ id: '1c-' + id, deal_id: id, status: 'only_1c', contractor: c.contractor, name_1c: c.name, name_b24: '', sum_1c: c.sum, sum_b24: null, dept_1c: c.dept, dept_b24: '', diff_fields: '' }); continue; }
    seenB24.add(id);
    const diffs = [];
    if (Math.abs(Number(c.sum || 0) - Number(d.sum || 0)) > SUM_TOLERANCE) diffs.push('сумма');
    if (norm(c.name) && norm(d.title) && norm(c.name) !== norm(d.title)) diffs.push('наименование');
    if (c.dept && d.dept && c.dept !== d.dept) diffs.push('отдел');
    rows.push({ id: 'pair-' + id, deal_id: id, status: diffs.length ? 'diff' : 'ok', contractor: c.contractor, name_1c: c.name, name_b24: d.title, sum_1c: c.sum, sum_b24: d.sum, dept_1c: c.dept, dept_b24: d.dept, diff_fields: diffs.join(', ') });
  }
  for (const d of listB24) { const id = String(d.deal_id || '').trim(); if (id && !seenB24.has(id) && !rows.some(r => r.deal_id === id && r.status !== 'only_1c')) rows.push({ id: 'b24-' + id, deal_id: id, status: 'only_b24', contractor: '', name_1c: '', name_b24: d.title, sum_1c: null, sum_b24: d.sum, dept_1c: '', dept_b24: d.dept, diff_fields: '' }); }
  return rows;
}
function norm(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[«»"']/g, '').trim(); }

async function syncQuality() {
  await ensureSchema();
  const mock = !onecMod.isConfigured();
  try {
    const [a, b] = await Promise.all([fetch1CContracts(), fetchBitrixDeals()]);
    const rows = buildPairs(a, b);
    await pool.query('DELETE FROM ticketsmodule_onec_quality');
    for (const r of rows) {
      await pool.query(
        `INSERT INTO ticketsmodule_onec_quality (id, deal_id, status, contractor, name_1c, name_b24, sum_1c, sum_b24, dept_1c, dept_b24, diff_fields)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET deal_id=$2,status=$3,contractor=$4,name_1c=$5,name_b24=$6,sum_1c=$7,sum_b24=$8,dept_1c=$9,dept_b24=$10,diff_fields=$11,synced_at=NOW()`,
        [r.id, r.deal_id || '', r.status, r.contractor || '', r.name_1c || '', r.name_b24 || '', r.sum_1c, r.sum_b24, r.dept_1c || '', r.dept_b24 || '', r.diff_fields || '']);
    }
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_ok_at, is_mock, last_error)
       VALUES ('quality', NOW(), NOW(), $1, NULL)
       ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_ok_at=NOW(), is_mock=$1, last_error=NULL`, [mock]);
    return { ok: true, count: rows.length, mock };
  } catch (e) {
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_error, is_mock)
       VALUES ('quality', NOW(), $1, $2) ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_error=$1, is_mock=$2`,
      [String(e && e.message || e).slice(0, 300), mock]).catch(() => {});
    return { ok: false, error: String(e && e.message || e), mock };
  }
}

async function getQualityBoard() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_onec_quality ORDER BY status, contractor');
  if (!rows.length) { await syncQuality(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_onec_quality ORDER BY status, contractor')); }
  const meta = (await pool.query(`SELECT * FROM ticketsmodule_onec_meta WHERE source='quality'`)).rows[0] || {};
  const by = s => rows.filter(r => r.status === s).length;
  return {
    rows: rows.map(r => ({
      id: r.id, deal_id: r.deal_id, status: r.status, contractor: r.contractor,
      name_1c: r.name_1c, name_b24: r.name_b24,
      sum_1c: r.sum_1c != null ? Number(r.sum_1c) : null, sum_b24: r.sum_b24 != null ? Number(r.sum_b24) : null,
      dept_1c: r.dept_1c, dept_b24: r.dept_b24, diff_fields: r.diff_fields,
    })),
    summary: { total: rows.length, ok: by('ok'), diff: by('diff'), only_1c: by('only_1c'), only_b24: by('only_b24'), no_link: by('no_link') },
    asOf: meta.last_sync || null, mock: meta.is_mock !== false, error: meta.last_error || null,
  };
}

module.exports = { ensureSchema, syncQuality, getQualityBoard };

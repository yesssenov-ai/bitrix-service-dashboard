// «Авансы» · правая панель «Данные Excel» — файл бухгалтера «Анализ по Контрактам»
// на Диске Битрикса. Источник: disk.file.get (id из env ADV_EXCEL_FILE_ID, по умолчанию
// 95057) → DOWNLOAD_URL → разбор xlsx/xls. Запасной путь — ручная загрузка файла
// (POST /api/finance/advances/excel-upload), если у вебхука нет права «Диск».
//
// Логика — как в самом файле:
//   • каждый лист = год исполнения (2023, 2024 …); лист «2021-2022» делится по году
//     даты договора. Многолетний договор стоит на нескольких листах со своей суммой
//     за год — это не дубль, а доля года;
//   • колонки ищем по ЗАГОЛОВКАМ (на листах они сдвинуты): «Наименование Заказчика»,
//     «Номер договора», «Дата договора», «Сумма договора», «Сумма оплаты»,
//     «Ответственный отдел», «Будущие оплаты», «ID»;
//   • Остаток = «Будущие оплаты» (=F−L у бухгалтера; ноль, если бухгалтер обнулил
//     будущую оплату вручную). На листах без этой колонки (2021–2023) — Сумма − Оплаты;
//   • строки без заказчика и строки «ИТОГО»/SUM/SUBTOTAL пропускаем.
const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { pool } = require('./auth');

const FILE_ID = () => String(process.env.ADV_EXCEL_FILE_ID || '95057').trim();

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_adv_excel (
        id SERIAL PRIMARY KEY,
        year INTEGER,
        sheet VARCHAR(40),
        row_no INTEGER,
        department VARCHAR(120),
        company VARCHAR(400),
        end_user VARCHAR(400),
        contract VARCHAR(500),
        contract_date DATE,
        contract_sum NUMERIC DEFAULT 0,
        payments NUMERIC DEFAULT 0,
        balance NUMERIC DEFAULT 0,
        kind VARCHAR(60),
        execution VARCHAR(120),
        bitrix_deal_id VARCHAR(40));
      CREATE INDEX IF NOT EXISTS idx_adv_excel_year ON ticketsmodule_adv_excel(year);
      CREATE TABLE IF NOT EXISTS ticketsmodule_adv_excel_meta (
        id INTEGER PRIMARY KEY,
        source VARCHAR(20),
        file_id VARCHAR(40),
        file_name VARCHAR(300),
        file_updated TIMESTAMPTZ,
        last_try TIMESTAMPTZ,
        last_ok_at TIMESTAMPTZ,
        last_error TEXT,
        row_count INTEGER);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Разбор книги ─────────────────────────────────────────────────────────────
const HEAD = {
  company: /наименование\s+заказчика/i,
  endUser: /конечный/i,
  contract: /номер\s+договора/i,
  date: /дата\s+договора/i,
  sum: /сумма\s+договора/i,
  kind: /сервис\s*\/\s*прибор/i,
  paid: /сумма\s+оплаты/i,
  exec: /исполнение/i,
  dept: /ответственный\s+отдел/i,
  future: /будущие\s+оплаты/i,
  id: /^id$/i,
};
// Отделы в файле местами названы по-разному — сводим к именам 1С.
const DEPT_ALIAS = { 'запчасти и расходники': 'Spares' };
function normDept(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return DEPT_ALIAS[s.toLowerCase()] || s;
}
function num(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = Number(String(v).replace(/[\s ]/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}
// Дата Excel (серийное число) или строка «дд.мм.гггг[/…]» → Date|null
function toDate(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d));
  }
  const m = String(v == null ? '' : v).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}
const isYearSheet = n => /^\s*\d{4}(\s*-\s*\d{4})?\s*$/.test(n);

function parseWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const out = [];
  const enc = XLSX.utils.encode_cell;
  for (const name of wb.SheetNames) {
    if (!isYearSheet(name)) continue;
    const ws = wb.Sheets[name];
    if (!ws || !ws['!ref']) continue;
    const range = XLSX.utils.decode_range(ws['!ref']);
    const yrs = name.match(/\d{4}/g).map(Number);
    const yMin = Math.min(...yrs), yMax = Math.max(...yrs);
    // Строка заголовков — та, где есть «Наименование Заказчика» (в первых 20 строках).
    let hr = -1;
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 20) && hr < 0; r++) {
      for (let c = range.s.c; c <= Math.min(range.e.c, 10); c++) {
        const cell = ws[enc({ r, c })];
        if (cell && HEAD.company.test(String(cell.v))) { hr = r; break; }
      }
    }
    if (hr < 0) continue;
    const col = {};
    for (let c = range.s.c; c <= Math.min(range.e.c, 60); c++) {
      const cell = ws[enc({ r: hr, c })];
      if (!cell) continue;
      const t = String(cell.v).replace(/\s+/g, ' ').trim();
      for (const k of Object.keys(HEAD)) if (col[k] == null && HEAD[k].test(t)) col[k] = c;
    }
    if (col.company == null || col.sum == null) continue;
    const get = (r, k) => { if (col[k] == null) return null; const cell = ws[enc({ r, c: col[k] })]; return cell ? cell.v : null; };
    for (let r = hr + 1; r <= range.e.r; r++) {
      const company = String(get(r, 'company') == null ? '' : get(r, 'company')).replace(/\s+/g, ' ').trim();
      if (!company || /^итог/i.test(company)) continue;
      const sum = num(get(r, 'sum')), paid = num(get(r, 'paid'));
      const fut = col.future != null ? get(r, 'future') : null;
      const balance = (fut != null && fut !== '') ? num(fut) : sum - paid;
      const date = toDate(get(r, 'date'));
      let year = yMin;
      if (yMin !== yMax) { const dy = date ? date.getUTCFullYear() : yMax; year = Math.min(yMax, Math.max(yMin, dy)); }
      const idRaw = get(r, 'id');
      const dealId = /^\d{3,}$/.test(String(idRaw == null ? '' : idRaw).trim()) ? String(idRaw).trim() : null;
      out.push({
        year, sheet: name, row_no: r + 1,
        department: normDept(get(r, 'dept')),
        company,
        end_user: String(get(r, 'endUser') || '').replace(/\s+/g, ' ').trim(),
        contract: String(get(r, 'contract') == null ? '' : get(r, 'contract')).replace(/\s+/g, ' ').trim(),
        contract_date: date ? date.toISOString().slice(0, 10) : null,
        contract_sum: Math.round(sum * 100) / 100,
        payments: Math.round(paid * 100) / 100,
        balance: Math.round(balance * 100) / 100,
        kind: String(get(r, 'kind') || '').trim().slice(0, 60),
        execution: String(get(r, 'exec') || '').trim().slice(0, 120),
        bitrix_deal_id: dealId,
      });
    }
  }
  return out;
}

// ── Забор файла с Диска Битрикса ────────────────────────────────────────────
async function downloadFromBitrix() {
  const { b24 } = require('./bitrix');
  const id = FILE_ID();
  let info;
  try { info = await b24('disk.file.get', { id }); }
  catch (e) {
    if (/insufficient_scope|HTTP 401|HTTP 403|ACCESS_DENIED/i.test(e.message)) {
      const err = new Error('У вебхука Битрикса нет права «Диск» (disk) — включите его или загрузите файл вручную');
      err.userFacing = true; throw err;
    }
    throw e;
  }
  const f = info && info.result;
  if (!f || !f.DOWNLOAD_URL) throw new Error(`Файл ${id} на Диске не найден или недоступен вебхуку`);
  const r = await fetch(f.DOWNLOAD_URL, { timeout: 60000 });
  if (!r.ok) throw new Error(`Скачивание файла: HTTP ${r.status}`);
  const buffer = await r.buffer();
  return { buffer, name: f.NAME || '', updated: f.UPDATE_TIME || null, fileId: id };
}

async function saveRows(rows, meta) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM ticketsmodule_adv_excel');
    const cols = ['year', 'sheet', 'row_no', 'department', 'company', 'end_user', 'contract', 'contract_date', 'contract_sum', 'payments', 'balance', 'kind', 'execution', 'bitrix_deal_id'];
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const vals = [], ph = [];
      chunk.forEach((r, j) => {
        ph.push('(' + cols.map((_, k) => '$' + (j * cols.length + k + 1)).join(',') + ')');
        cols.forEach(c => vals.push(r[c] === undefined ? null : r[c]));
      });
      await client.query(`INSERT INTO ticketsmodule_adv_excel (${cols.join(',')}) VALUES ${ph.join(',')}`, vals);
    }
    await client.query(
      `INSERT INTO ticketsmodule_adv_excel_meta (id, source, file_id, file_name, file_updated, last_try, last_ok_at, last_error, row_count)
       VALUES (1,$1,$2,$3,$4,NOW(),NOW(),NULL,$5)
       ON CONFLICT (id) DO UPDATE SET source=$1,file_id=$2,file_name=$3,file_updated=$4,last_try=NOW(),last_ok_at=NOW(),last_error=NULL,row_count=$5`,
      [meta.source, meta.fileId || null, meta.name || null, meta.updated || null, rows.length]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

async function markError(msg) {
  await pool.query(
    `INSERT INTO ticketsmodule_adv_excel_meta (id, last_try, last_error) VALUES (1, NOW(), $1)
     ON CONFLICT (id) DO UPDATE SET last_try=NOW(), last_error=$1`, [String(msg).slice(0, 300)]).catch(() => {});
}

// Синк с Диска Битрикса. Ошибка не роняет старые данные — остаются последние удачные.
async function syncExcel() {
  await ensureSchema();
  try {
    const f = await downloadFromBitrix();
    const rows = parseWorkbook(f.buffer);
    if (!rows.length) throw new Error('В файле не найдено ни одного листа-года с договорами');
    await saveRows(rows, { source: 'bitrix', fileId: f.fileId, name: f.name, updated: f.updated });
    return { ok: true, count: rows.length };
  } catch (e) {
    await markError(e.message);
    return { ok: false, error: e.message };
  }
}

// Ручная загрузка файла (запасной путь).
async function importUpload(buffer, filename) {
  await ensureSchema();
  const rows = parseWorkbook(buffer);
  if (!rows.length) { const e = new Error('В файле не найдено ни одного листа-года (2023, 2024 …) с колонкой «Наименование Заказчика»'); e.userFacing = true; throw e; }
  await saveRows(rows, { source: 'upload', name: filename || 'файл', updated: new Date().toISOString() });
  return { ok: true, count: rows.length };
}

async function getExcelBoard() {
  await ensureSchema();
  const meta = (await pool.query('SELECT * FROM ticketsmodule_adv_excel_meta WHERE id=1')).rows[0] || null;
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_adv_excel ORDER BY year DESC, department, company, contract');
  if (!rows.length && !meta) return { configured: false };
  return {
    configured: true,
    source: meta && meta.source || null,
    fileName: meta && meta.file_name || null,
    fileUpdated: meta && meta.file_updated || null,
    asOf: meta && meta.last_ok_at || null,
    error: meta && meta.last_error || null,
    rows: rows.map(r => ({
      year: r.year, sheet: r.sheet, department: r.department || '', company: r.company, endUser: r.end_user || '',
      contract: r.contract || '', date: r.contract_date || null,
      contract_sum: Number(r.contract_sum || 0), payments: Number(r.payments || 0), balance: Number(r.balance || 0),
      kind: r.kind || '', execution: r.execution || '', bitrix_deal_id: r.bitrix_deal_id || null,
    })),
  };
}

module.exports = { ensureSchema, parseWorkbook, syncExcel, importUpload, getExcelBoard };

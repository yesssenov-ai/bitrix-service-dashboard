// Импорт пофирменных сумм тарифа из instrumentsexport.xlsx (лист «Приборы»).
//
// Запуск в Railway Console:
//   node import-instrument-tariffs.js <путь-к-instrumentsexport.xlsx>
//
// Лист «Приборы», колонки:
//   A = ID прибора в Bitrix (не менять)
//   B = Название прибора
//   C = Установка+обучение USD
//   D = Методическое обучение USD
//   E = Комментарий (игнорируется)
//
// Идемпотентно: строки апсертятся по bitrix_pribor_id, поэтому повторный
// импорт обновлённого файла просто перезаписывает суммы, а не плодит дубли.
// Суммы пишутся ПРЯМО в ticketsmodule_instrument_category_map (install_usd /
// methodical_usd) — они имеют приоритет над категорийными тарифами при расчёте.

const XLSX = require('xlsx');
const { pool, initDB } = require('./auth');

function num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) { console.error('Usage: node import-instrument-tariffs.js <path-to-xlsx>'); process.exit(1); }

  await initDB(); // гарантирует наличие колонок install_usd / methodical_usd

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets['Приборы'];
  if (!ws) { console.error('В файле нет листа «Приборы». Листы:', wb.SheetNames.join(', ')); process.exit(1); }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  let ok = 0, skipped = 0, withAmounts = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const pid = parseInt(String(r[0]).trim(), 10);
      if (!pid) { skipped++; continue; }
      const name = (r[1] != null ? String(r[1]) : '').trim() || String(pid);
      const install = num(r[2]);
      const method = num(r[3]);
      if (install != null || method != null) withAmounts++;

      await client.query(
        `INSERT INTO ticketsmodule_instrument_category_map
           (bitrix_pribor_id, pribor_name, install_usd, methodical_usd)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (bitrix_pribor_id) DO UPDATE
           SET pribor_name    = EXCLUDED.pribor_name,
               install_usd    = EXCLUDED.install_usd,
               methodical_usd = EXCLUDED.methodical_usd`,
        [pid, name, install, method]
      );
      ok++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  console.log(`Импорт завершён: ${ok} приборов (${withAmounts} с суммами тарифа), пропущено строк без ID: ${skipped}`);
  await pool.end();
  process.exit(0);
}

main().catch(e => { console.error('Ошибка импорта:', e); process.exit(1); });

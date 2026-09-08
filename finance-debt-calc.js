// Модуль «Дебет» (дебиторская задолженность). Источник — 1С (когда настроена)
// либо мок-данные (пока сервисы 1С не готовы). Данные кэшируются в зеркале
// ticketsmodule_onec_debt; страница отдаёт кэш мгновенно, кнопка «Обновить»
// пересобирает. Когда появятся HTTP-сервисы 1С — правим ТОЛЬКО fetchDebtRaw().
const { pool } = require('./auth');
const onecMod = require('./onec');

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_debt (
        id VARCHAR(120) PRIMARY KEY,
        contractor VARCHAR(400),
        contract VARCHAR(400),
        department VARCHAR(120),
        debt NUMERIC DEFAULT 0,
        overdue_days INTEGER DEFAULT 0,
        due_date DATE,
        bitrix_deal_id VARCHAR(40),
        contract_sum NUMERIC,
        synced_at TIMESTAMPTZ DEFAULT NOW());
      ALTER TABLE ticketsmodule_onec_debt ADD COLUMN IF NOT EXISTS bitrix_deal_id VARCHAR(40);
      ALTER TABLE ticketsmodule_onec_debt ADD COLUMN IF NOT EXISTS contract_sum NUMERIC;
      CREATE INDEX IF NOT EXISTS idx_onec_debt_dept ON ticketsmodule_onec_debt(department);
      CREATE INDEX IF NOT EXISTS idx_onec_debt_deal ON ticketsmodule_onec_debt(bitrix_deal_id);
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_meta (
        source VARCHAR(40) PRIMARY KEY,
        last_sync TIMESTAMPTZ, last_ok_at TIMESTAMPTZ, last_error TEXT, is_mock BOOLEAN DEFAULT true);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Мок-данные (пока нет 1С) — форма как в PBI: контрагент → договор(ы), долг,
// дней до срока (отрицательное) / просрочки (положительное), отдел. ────────────
function mockDebt() {
  const DEPTS = ['Элементный', 'Хроматография', 'Электрохимия', 'Service', 'Training'];
  const NAMES = [
    'NFC Kazakhstan ТОО', 'Qazaq Kaolin ТОО', 'ИЯФ РГП на ПХВ', 'КАЗНУ ИМЕНИ АЛЬ-ФАРАБИ НАО',
    'BMT Holding Limited', 'КазНИИ Каспийского моря НАО', 'ЖАНАЛАБ ТОО', 'БОЗШАКОЛЬ',
    'ЮРС Федерал Сервисез Инк. (США)', 'НИЦ Уголь', 'ALAYGYR GOLD ТОО', 'KOPA GOLD Limited ЧК',
    'STS-Astana NS', 'Karaganda Analytical', 'Tenge Lab ТОО', 'Astana BioTest',
  ];
  const rows = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  NAMES.forEach((nm, i) => {
    const dept = DEPTS[i % DEPTS.length];
    const contracts = 1 + Math.floor(rnd() * 2);
    for (let c = 0; c < contracts; c++) {
      const debt = Math.round((300000 + rnd() * 69000000) / 100) * 100;
      const overdue = Math.round((rnd() - 0.5) * 200); // от -100 до +100 дней
      rows.push({
        id: `MOCK-${i}-${c}`,
        contractor: nm,
        contract: `ДОГОВОР ПОСТАВКИ №Inst-${1000 + i}${c}/2026 от 0${1 + (i % 9)}.0${1 + (c % 9)}.2026`,
        department: dept,
        debt,
        overdue_days: overdue,
        due_date: null,
        bitrix_deal_id: String(2000 + i * 3 + c), // демо: id сделки Битрикса
        contract_sum: debt + Math.round(rnd() * 20000000),
      });
    }
  });
  return rows;
}

// Счета дебиторки в 1С (обычно 1210). Можно переопределить через env.
const DEBT_ACCOUNTS = (process.env.ONEC_DEBT_ACCOUNTS || '1210').split(',').map(s => s.trim()).filter(Boolean);
// Поле в dim_contract с ID сделки Битрикса (ключ сверки 1С↔Битрикс). 1С-ники
// завели его в договоре; точное имя подставим здесь (или через env).
function dealIdOf(c) {
  const key = process.env.ONEC_CONTRACT_DEAL_FIELD;
  const v = (key && c[key] != null) ? c[key]
    : (c.IDСделки ?? c.БитриксСделка ?? c.BitrixDealId ?? c.bitrix_deal_id ?? c.deal_id ?? null);
  return v == null || v === '' ? null : String(v).trim();
}

// Единая точка получения строк долга.
// Реальные данные 1С — звёздная схема (по спецификации заказчика):
//   dim_contract(contract_id, Name, СрокОплаты, ОтветственныйОтдел, СуммаДоговора,
//                ДатаДоговора, contractor_id)
//   dim_contractor(contractor_id, Name)
//   12_33_MS(Account, Date, CorrAccount, AmountDt, AmountKt, Contractor_id, Contract_id)
// Долг по договору = Σ(AmountDt − AmountKt) по счетам дебиторки; срок/отдел — из
// dim_contract, контрагент — из dim_contractor. Имена HTTP-сервисов подгоним, когда
// 1С их опубликует (ниже — рабочее предположение по именам таблиц).
async function fetchDebtRaw() {
  if (!onecMod.isConfigured()) return mockDebt();

  const [contractsRaw, contractorsRaw, ledgerRaw] = await Promise.all([
    onecMod.onec('dim_contract'),
    onecMod.onec('dim_contractor'),
    onecMod.onec('12_33_MS'),
  ]);
  const asArr = d => Array.isArray(d) ? d : (d && (d.rows || d.data || d.value)) || [];
  const contracts = asArr(contractsRaw);
  const contractors = asArr(contractorsRaw);
  const ledger = asArr(ledgerRaw);

  const contractorName = {};
  for (const c of contractors) contractorName[String(c.contractor_id ?? c.Contractor_id ?? c.id)] = c.Name || c.name || '';

  // Остаток по каждому договору из проводок (только счета дебиторки).
  const balByContract = {};
  for (const e of ledger) {
    if (DEBT_ACCOUNTS.length && !DEBT_ACCOUNTS.includes(String(e.Account ?? e.account))) continue;
    const cid = String(e.Contract_id ?? e.contract_id ?? '');
    if (!cid) continue;
    balByContract[cid] = (balByContract[cid] || 0) + (Number(e.AmountDt ?? 0) - Number(e.AmountKt ?? 0));
  }

  const today = new Date();
  const rows = [];
  for (const c of contracts) {
    const cid = String(c.contract_id ?? c.id ?? '');
    const debt = Math.round((balByContract[cid] || 0));
    if (!debt) continue; // показываем только договоры с ненулевым долгом
    const due = c.СрокОплаты || c.due_date || null;
    let overdue = 0;
    if (due) { const d = new Date(due); if (!isNaN(d)) overdue = Math.round((today - d) / 86400000); }
    rows.push({
      id: cid || (String(c.contractor_id) + '|' + (c.Name || '')),
      contractor: contractorName[String(c.contractor_id ?? c.Contractor_id)] || '',
      contract: c.Name || c.name || ('Договор #' + cid),
      department: c.ОтветственныйОтдел || c.department || '',
      debt,
      overdue_days: debt > 0 ? overdue : 0,
      due_date: due,
      bitrix_deal_id: dealIdOf(c),
      contract_sum: Number(c.СуммаДоговора ?? c.contract_sum ?? 0) || null,
    });
  }
  return rows;
}

async function syncDebt() {
  await ensureSchema();
  const mock = !onecMod.isConfigured();
  try {
    const rows = await fetchDebtRaw();
    await pool.query('DELETE FROM ticketsmodule_onec_debt');
    for (const r of rows) {
      await pool.query(
        `INSERT INTO ticketsmodule_onec_debt (id, contractor, contract, department, debt, overdue_days, due_date, bitrix_deal_id, contract_sum)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET contractor=$2, contract=$3, department=$4, debt=$5, overdue_days=$6, due_date=$7, bitrix_deal_id=$8, contract_sum=$9, synced_at=NOW()`,
        [r.id, r.contractor || '', r.contract || '', r.department || '', r.debt || 0, r.overdue_days || 0, r.due_date || null, r.bitrix_deal_id || null, r.contract_sum || null]);
    }
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_ok_at, is_mock, last_error)
       VALUES ('debt', NOW(), NOW(), $1, NULL)
       ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_ok_at=NOW(), is_mock=$1, last_error=NULL`, [mock]);
    return { ok: true, count: rows.length, mock };
  } catch (e) {
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_error, is_mock)
       VALUES ('debt', NOW(), $1, $2)
       ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_error=$1, is_mock=$2`,
      [String(e && e.message || e).slice(0, 300), mock]).catch(() => {});
    return { ok: false, error: String(e && e.message || e), mock };
  }
}

async function getDebtBoard() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_onec_debt ORDER BY contractor, contract');
  if (!rows.length) { await syncDebt(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_onec_debt ORDER BY contractor, contract')); }
  const meta = (await pool.query(`SELECT * FROM ticketsmodule_onec_meta WHERE source='debt'`)).rows[0] || {};

  const byDept = {};
  for (const r of rows) {
    const d = r.department || '—';
    byDept[d] = byDept[d] || { department: d, total: 0, overdue: 0 };
    byDept[d].total += Number(r.debt || 0);
    if (Number(r.overdue_days) > 0) byDept[d].overdue += Number(r.debt || 0);
  }
  const depts = Object.values(byDept).sort((a, b) => b.total - a.total);
  const totalDebt = rows.reduce((a, r) => a + Number(r.debt || 0), 0);
  const totalOverdue = rows.filter(r => Number(r.overdue_days) > 0).reduce((a, r) => a + Number(r.debt || 0), 0);

  return {
    rows: rows.map(r => ({
      id: r.id, contractor: r.contractor, contract: r.contract, department: r.department,
      debt: Number(r.debt || 0), overdue_days: Number(r.overdue_days || 0), due_date: r.due_date,
      bitrix_deal_id: r.bitrix_deal_id || null, contract_sum: r.contract_sum != null ? Number(r.contract_sum) : null,
    })),
    depts, totals: { debt: totalDebt, overdue: totalOverdue },
    asOf: meta.last_sync || null, mock: meta.is_mock !== false, error: meta.last_error || null,
    filters: {
      departments: [...new Set(rows.map(r => r.department).filter(Boolean))].sort(),
      contractors: [...new Set(rows.map(r => r.contractor).filter(Boolean))].sort(),
    },
  };
}

module.exports = { ensureSchema, syncDebt, getDebtBoard };

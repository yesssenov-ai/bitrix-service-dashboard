// Модуль «Авансы». По договору: Сумма договора (dim_contract), Авансы (счёт 3510),
// Оплаты (1210 с корсчётами 1010/1030), Остаток = Сумма − Авансы − Оплаты.
// Дерево год → отдел → контрагент → договор. Источник — 1С (когда настроена),
// иначе мок. Реальные данные — правим ТОЛЬКО fetchAdvancesRaw().
const { pool } = require('./auth');
const onecMod = require('./onec');

const ADV_ACCOUNTS = (process.env.ONEC_ADVANCE_ACCOUNTS || '3510').split(',').map(s => s.trim()).filter(Boolean);
const PAY_ACCOUNT = process.env.ONEC_PAYMENT_ACCOUNT || '1210';
const PAY_CORR = (process.env.ONEC_PAYMENT_CORR || '1010,1030').split(',').map(s => s.trim()).filter(Boolean);

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_advances (
        id VARCHAR(120) PRIMARY KEY,
        year INTEGER,
        department VARCHAR(120),
        contractor VARCHAR(400),
        contract VARCHAR(500),
        contract_sum NUMERIC DEFAULT 0,
        advances NUMERIC DEFAULT 0,
        payments NUMERIC DEFAULT 0,
        balance NUMERIC DEFAULT 0,
        bitrix_deal_id VARCHAR(40),
        synced_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_onec_adv_year ON ticketsmodule_onec_advances(year);
      CREATE INDEX IF NOT EXISTS idx_onec_adv_dept ON ticketsmodule_onec_advances(department);
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_meta (
        source VARCHAR(40) PRIMARY KEY,
        last_sync TIMESTAMPTZ, last_ok_at TIMESTAMPTZ, last_error TEXT, is_mock BOOLEAN DEFAULT true);
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Мок-данные ───────────────────────────────────────────────────────────────
function mockAdvances() {
  const DEPTS = ['Элементный', 'Хроматография', 'Электрохимия', 'Service', 'Training'];
  const NAMES = ['NFC Kazakhstan ТОО', 'Qazaq Kaolin ТОО', 'ИЯФ РГП на ПХВ', 'BMT Holding Limited',
    'ЖАНАЛАБ ТОО', 'БОЗШАКОЛЬ', 'НИЦ Уголь', 'ALAYGYR GOLD ТОО', 'KOPA GOLD Limited ЧК', 'STS-Astana NS'];
  const YEARS = [2024, 2025, 2026, 2027];
  let seed = 5; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const rows = [];
  YEARS.forEach(y => {
    NAMES.forEach((nm, i) => {
      if (rnd() < 0.35) return; // не у всех контрагентов договор каждый год
      const dept = DEPTS[i % DEPTS.length];
      const contracts = 1 + Math.floor(rnd() * 2);
      for (let c = 0; c < contracts; c++) {
        const sum = Math.round((5000000 + rnd() * 150000000) / 100) * 100;
        const advances = Math.round(sum * rnd() * 0.5 / 100) * 100;
        const payments = Math.round((sum - advances) * rnd() * 0.6 / 100) * 100;
        rows.push({
          id: `A-${y}-${i}-${c}`, year: y, department: dept, contractor: nm,
          contract: `ДОГОВОР №${y}/${100 + i}${c}`,
          contract_sum: sum, advances, payments, balance: sum - advances - payments,
          bitrix_deal_id: String(2000 + i * 3 + c),
        });
      }
    });
  });
  return rows;
}

// Реальные данные 1С: dim_contract + dim_contractor + 12_33_MS.
// Авансы = Σ(AmountKt−AmountDt) по счёту 3510; Оплаты = Σ AmountKt по 1210 с
// корсчётами 1010/1030; год — из ДатаДоговора.
async function fetchAdvancesRaw() {
  if (!onecMod.isConfigured()) return mockAdvances();
  const [cRaw, crRaw, lRaw] = await Promise.all([
    onecMod.onec('dim_contract'), onecMod.onec('dim_contractor'), onecMod.onec('12_33_MS'),
  ]);
  const asArr = d => Array.isArray(d) ? d : (d && (d.rows || d.data || d.value)) || [];
  const contracts = asArr(cRaw), ledger = asArr(lRaw);
  const nameById = {}; asArr(crRaw).forEach(x => nameById[String(x.contractor_id ?? x.Contractor_id)] = x.Name || '');

  const adv = {}, pay = {};
  for (const e of ledger) {
    const cid = String(e.Contract_id ?? e.contract_id ?? ''); if (!cid) continue;
    const acc = String(e.Account ?? e.account); const corr = String(e.CorrAccount ?? e.corr ?? '');
    const dt = Number(e.AmountDt ?? 0), kt = Number(e.AmountKt ?? 0);
    if (ADV_ACCOUNTS.includes(acc)) adv[cid] = (adv[cid] || 0) + (kt - dt);
    if (acc === PAY_ACCOUNT && PAY_CORR.includes(corr)) pay[cid] = (pay[cid] || 0) + kt;
  }
  return contracts.map(c => {
    const cid = String(c.contract_id ?? c.id ?? '');
    const sum = Number(c.СуммаДоговора ?? c.contract_sum ?? 0);
    const advances = Math.round(adv[cid] || 0), payments = Math.round(pay[cid] || 0);
    const dd = c.ДатаДоговора || c.date || null; const year = dd ? new Date(dd).getFullYear() : null;
    return {
      id: cid, year, department: c.ОтветственныйОтдел || '', contractor: nameById[String(c.contractor_id ?? c.Contractor_id)] || '',
      contract: c.Name || ('Договор #' + cid), contract_sum: sum, advances, payments, balance: sum - advances - payments,
      bitrix_deal_id: String(c.IDСделки ?? c.БитриксСделка ?? c.bitrix_deal_id ?? (process.env.ONEC_CONTRACT_DEAL_FIELD ? c[process.env.ONEC_CONTRACT_DEAL_FIELD] : '') ?? '').trim() || null,
    };
  });
}

async function syncAdvances() {
  await ensureSchema();
  const mock = !onecMod.isConfigured();
  try {
    const rows = await fetchAdvancesRaw();
    await pool.query('DELETE FROM ticketsmodule_onec_advances');
    for (const r of rows) {
      await pool.query(
        `INSERT INTO ticketsmodule_onec_advances (id, year, department, contractor, contract, contract_sum, advances, payments, balance, bitrix_deal_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET year=$2,department=$3,contractor=$4,contract=$5,contract_sum=$6,advances=$7,payments=$8,balance=$9,bitrix_deal_id=$10,synced_at=NOW()`,
        [r.id, r.year || null, r.department || '', r.contractor || '', r.contract || '', r.contract_sum || 0, r.advances || 0, r.payments || 0, r.balance || 0, r.bitrix_deal_id || null]);
    }
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_ok_at, is_mock, last_error)
       VALUES ('advances', NOW(), NOW(), $1, NULL)
       ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_ok_at=NOW(), is_mock=$1, last_error=NULL`, [mock]);
    return { ok: true, count: rows.length, mock };
  } catch (e) {
    await pool.query(
      `INSERT INTO ticketsmodule_onec_meta (source, last_sync, last_error, is_mock)
       VALUES ('advances', NOW(), $1, $2) ON CONFLICT (source) DO UPDATE SET last_sync=NOW(), last_error=$1, is_mock=$2`,
      [String(e && e.message || e).slice(0, 300), mock]).catch(() => {});
    return { ok: false, error: String(e && e.message || e), mock };
  }
}

async function getAdvancesBoard() {
  await ensureSchema();
  let { rows } = await pool.query('SELECT * FROM ticketsmodule_onec_advances ORDER BY year DESC, department, contractor, contract');
  if (!rows.length) { await syncAdvances(); ({ rows } = await pool.query('SELECT * FROM ticketsmodule_onec_advances ORDER BY year DESC, department, contractor, contract')); }
  const meta = (await pool.query(`SELECT * FROM ticketsmodule_onec_meta WHERE source='advances'`)).rows[0] || {};
  const uniq = f => [...new Set(rows.map(r => r[f]).filter(v => v !== null && v !== ''))].sort((a, b) => (b > a ? -1 : 1));
  return {
    rows: rows.map(r => ({
      id: r.id, year: r.year, department: r.department, contractor: r.contractor, contract: r.contract,
      contract_sum: Number(r.contract_sum || 0), advances: Number(r.advances || 0),
      payments: Number(r.payments || 0), balance: Number(r.balance || 0), bitrix_deal_id: r.bitrix_deal_id || null,
    })),
    asOf: meta.last_sync || null, mock: meta.is_mock !== false, error: meta.last_error || null,
    filters: { years: uniq('year'), departments: uniq('department'), contractors: uniq('contractor') },
  };
}

module.exports = { ensureSchema, syncAdvances, getAdvancesBoard };

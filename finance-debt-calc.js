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
      -- История суточных снимков для полосы обзора (тренды/дельты/спарклайны).
      -- Пишется при каждом успешном syncDebt; серию строим по последнему снимку в месяце.
      CREATE TABLE IF NOT EXISTS ticketsmodule_onec_debt_history (
        snap_date DATE PRIMARY KEY,
        total_debt NUMERIC DEFAULT 0, overdue NUMERIC DEFAULT 0,
        contractors INTEGER DEFAULT 0, avg_overdue NUMERIC DEFAULT 0,
        is_mock BOOLEAN DEFAULT true);
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
    : (c.bitrix_id ?? c.Bitrix_id ?? c.IDСделки ?? c.БитриксСделка ?? c.BitrixDealId ?? c.bitrix_deal_id ?? c.deal_id ?? null);
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

  // Для ОСТАТКА дебиторки берём ВСЮ историю проводок (входящее сальдо + движения),
  // иначе долг занижен относительно Power BI, который показывает полный остаток.
  // Начало периода настраивается env ONEC_BALANCE_FROM. Сервисы: dim/contract,
  // dim/contractor, fact/receivables?dateFrom&dateTo (счёт 1210). Ответ: {count, items}.
  const dateFrom = process.env.ONEC_BALANCE_FROM || '2000-01-01';
  const dateTo = new Date().toISOString().slice(0, 10);
  // Последовательно (не параллельно): первый запрос при включённом reuse стартует сеанс
  // 1С, следующие переиспользуют куку — иначе было бы 3 параллельных старта сеанса и
  // 3 тяжёлых запроса разом. Дебиторку тянем ПО ГОДАМ (onecRange), чтобы не упираться
  // в таймаут веб-публикации 1С (он отдавал 502 на одном большом запросе с 2000 г.).
  const contractsRaw = await onecMod.onec('dim/contract');
  const contractorsRaw = await onecMod.onec('dim/contractor');
  const ledgerRaw = await onecMod.onecRange('fact/receivables', { dateFrom, dateTo });
  const asArr = d => Array.isArray(d) ? d : (d && (d.items || d.rows || d.data || d.value)) || [];
  const contracts = asArr(contractsRaw);
  const contractors = asArr(contractorsRaw);
  const ledger = asArr(ledgerRaw);

  const contractorName = {};
  for (const c of contractors) contractorName[String(c.contractor_id ?? c.Contractor_id ?? c.id)] = c.Name || c.name || '';

  // Остаток по договору = Σ(AmountDt − AmountKt) по счёту 1210; попутно запоминаем
  // дату последней дебетовой проводки (от неё считаем срок оплаты).
  const balByContract = {};
  const lastDtByContract = {};
  for (const e of ledger) {
    if (DEBT_ACCOUNTS.length && !DEBT_ACCOUNTS.includes(String(e.Account ?? e.account))) continue;
    const cid = String(e.Contract_id ?? e.contract_id ?? '');
    if (!cid) continue;
    const dt = Number(e.AmountDt ?? 0), kt = Number(e.AmountKt ?? 0);
    balByContract[cid] = (balByContract[cid] || 0) + (dt - kt);
    if (dt > 0) {
      const d = e.Date || e.date; const ds = d ? String(d).slice(0, 10) : null;
      if (ds && (!lastDtByContract[cid] || ds > lastDtByContract[cid])) lastDtByContract[cid] = ds;
    }
  }

  const today = new Date();
  const rows = [];
  for (const c of contracts) {
    const cid = String(c.contract_id ?? c.id ?? '');
    const debt = Math.round((balByContract[cid] || 0));
    if (!debt) continue; // показываем только договоры с ненулевым долгом
    // СрокОплаты в 1С — это ЧИСЛО ДНЕЙ на оплату, а не дата. Дата платежа =
    // дата последней отгрузки/дебета (иначе дата договора) + N дней.
    const termDays = Number(c.СрокОплаты ?? c.term_days ?? 0) || 0;
    const base = lastDtByContract[cid] || (c.ДатаДоговора ? String(c.ДатаДоговора).slice(0, 10) : null);
    let due = null, overdue = 0;
    if (base) {
      const d = new Date(base);
      // Отсекаем «битые» даты 1С (напр. 0204-09-13 — опечатка ввода): иначе
      // просрочка уходит в десятки тысяч дней. Валиден год [2000 .. нынешний+6].
      const yr = d.getFullYear(), nowY = today.getFullYear();
      if (!isNaN(d) && yr >= 2000 && yr <= nowY + 6) {
        d.setDate(d.getDate() + termDays); due = d.toISOString().slice(0, 10); overdue = Math.round((today - d) / 86400000);
      }
    }
    rows.push({
      id: cid || (String(c.contractor_id) + '|' + (c.Name || '')),
      contractor: contractorName[String(c.contractor_id ?? c.Contractor_id)] || '',
      contract: c.Name || c.name || ('Договор #' + cid),
      department: c.ОтветственныйОтдел || c.department || '',
      debt,
      overdue_days: debt > 0 ? overdue : 0,
      due_date: due,
      term_days: termDays || null,
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
    // Суточный снимок для истории (обзор: тренды/дельты). Сбой истории не ломает синк.
    try {
      const totD = rows.reduce((a, r) => a + Number(r.debt || 0), 0);
      const ovd = rows.filter(r => Number(r.overdue_days) > 0).reduce((a, r) => a + Number(r.debt || 0), 0);
      const con = new Set(rows.map(r => r.contractor).filter(Boolean)).size;
      const od = rows.filter(r => Number(r.overdue_days) > 0).map(r => Number(r.overdue_days));
      const avgOd = od.length ? Math.round(od.reduce((a, b) => a + b, 0) / od.length) : 0;
      await pool.query(
        `INSERT INTO ticketsmodule_onec_debt_history (snap_date, total_debt, overdue, contractors, avg_overdue, is_mock)
         VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
         ON CONFLICT (snap_date) DO UPDATE SET total_debt=$1, overdue=$2, contractors=$3, avg_overdue=$4, is_mock=$5`,
        [totD, ovd, con, avgOd, mock]);
    } catch (e) { console.error('debt history snapshot error:', e.message); }
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

// ── Полоса обзора: KPI + дельты + серии 12 мес + доли отделов ───────────────
const RU_MON = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function _rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function buildDebtOverview(rows, mock) {
  const debt = rows.reduce((a, r) => a + Number(r.debt || 0), 0);
  const overdue = rows.filter(r => Number(r.overdue_days) > 0).reduce((a, r) => a + Number(r.debt || 0), 0);
  const contractors = new Set(rows.map(r => r.contractor).filter(Boolean)).size;
  const od = rows.filter(r => Number(r.overdue_days) > 0).map(r => Number(r.overdue_days));
  const avgOverdue = od.length ? Math.round(od.reduce((a, b) => a + b, 0) / od.length) : 0;

  // Доли по отделам: топ-3 + «Прочие» (правило дата-виз: надёжно различимы 3 цвета).
  const byDept = {};
  for (const r of rows) { const d = r.department || '—'; byDept[d] = (byDept[d] || 0) + Number(r.debt || 0); }
  const sorted = Object.entries(byDept).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  const restV = sorted.slice(3).reduce((a, x) => a + x.value, 0);
  const slices = sorted.slice(0, 3).concat(restV > 0 ? [{ name: 'Прочие отделы', value: restV }] : []);
  const dtot = slices.reduce((a, x) => a + x.value, 0) || 1;
  const depts = slices.map(s => ({ name: s.name, value: Math.round(s.value), pct: Math.round(s.value / dtot * 100) }));

  const now = new Date(), labels = [];
  for (let i = 11; i >= 0; i--) labels.push(RU_MON[new Date(now.getFullYear(), now.getMonth() - i, 1).getMonth()]);

  let sDebt, sOver, sCon, sAvg, synthetic = false, historyPoints = 0;
  if (mock) {
    // Демо-серия: 12 точек, заканчивается ТЕКУЩИМИ значениями (страница помечена «демо-данные»).
    synthetic = true;
    const rnd = _rng(7);
    const mk = (end, amp) => { const a = []; let b = end * 0.8; for (let i = 0; i < 11; i++) { b = b + (end - b) * (0.1 + i * 0.012) + (rnd() - 0.5) * end * amp; a.push(Math.max(0, Math.round(b))); } a.push(Math.round(end)); return a; };
    sDebt = mk(debt, 0.05); sOver = mk(overdue, 0.06); sCon = mk(contractors, 0.04); sAvg = mk(avgOverdue, 0.05);
  } else {
    const h = (await pool.query(`
      SELECT DISTINCT ON (date_trunc('month', snap_date)) date_trunc('month', snap_date) AS m,
             total_debt, overdue, contractors, avg_overdue
      FROM ticketsmodule_onec_debt_history
      WHERE snap_date >= (CURRENT_DATE - INTERVAL '13 months')
      ORDER BY date_trunc('month', snap_date), snap_date DESC`)).rows;
    historyPoints = h.length;
    const byMon = {};
    h.forEach(x => { const d = new Date(x.m); byMon[d.getFullYear() + '-' + d.getMonth()] = { debt: Number(x.total_debt), over: Number(x.overdue), con: Number(x.contractors), avg: Number(x.avg_overdue) }; });
    sDebt = []; sOver = []; sCon = []; sAvg = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const v = byMon[d.getFullYear() + '-' + d.getMonth()]; sDebt.push(v ? v.debt : null); sOver.push(v ? v.over : null); sCon.push(v ? v.con : null); sAvg.push(v ? v.avg : null); }
    sDebt[11] = Math.round(debt); sOver[11] = Math.round(overdue); sCon[11] = contractors; sAvg[11] = avgOverdue;
  }

  const prevOf = (arr) => { for (let i = arr.length - 2; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  const kpi = (cur, arr) => { const p = prevOf(arr); return { value: cur, delta: p == null ? null : cur - p, pct: (p == null || p === 0) ? null : Math.round((cur - p) / p * 1000) / 10 }; };

  // Контекст из ТЕКУЩЕГО снимка (без истории) — чтобы плитки были наполнены сразу.
  const conOverdue = new Set(rows.filter(r => Number(r.overdue_days) > 0).map(r => r.contractor).filter(Boolean)).size;
  const maxOverdue = rows.reduce((m, r) => Math.max(m, Number(r.overdue_days) || 0), 0);
  const context = {
    overdueShare: debt > 0 ? overdue / debt : 0,       // доля просроченного в долге
    conOverdue,                                         // контрагентов с просрочкой
    maxOverdue,                                          // худшая просрочка, дн
    contracts: rows.length,                              // договоров всего
  };
  // Структура долга по срокам (aging) — считается из снимка, цветная, без выдумки.
  const aging = [
    { key: 'cur', label: 'Срок не наступил', value: 0 },
    { key: 'b1', label: '1–30 дн', value: 0 },
    { key: 'b2', label: '31–60 дн', value: 0 },
    { key: 'b3', label: '61–90 дн', value: 0 },
    { key: 'b4', label: '90+ дн', value: 0 },
  ];
  for (const r of rows) {
    const od = Number(r.overdue_days) || 0, v = Number(r.debt) || 0;
    const i = od <= 0 ? 0 : od <= 30 ? 1 : od <= 60 ? 2 : od <= 90 ? 3 : 4;
    aging[i].value += v;
  }
  aging.forEach(a => { a.value = Math.round(a.value); });

  return {
    mock, synthetic, historyPoints,
    kpis: { debt: kpi(Math.round(debt), sDebt), overdue: kpi(Math.round(overdue), sOver), contractors: kpi(contractors, sCon), avgOverdue: kpi(avgOverdue, sAvg) },
    series: { labels, debt: sDebt, overdue: sOver, contractors: sCon, avgOverdue: sAvg },
    depts, context, aging,
  };
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
  const overview = await buildDebtOverview(rows, meta.is_mock !== false);

  return {
    overview,
    rows: rows.map(r => ({
      id: r.id, contractor: r.contractor, contract: r.contract, department: r.department,
      debt: Number(r.debt || 0), overdue_days: Number(r.overdue_days || 0), due_date: r.due_date,
      bitrix_deal_id: r.bitrix_deal_id || null, contract_sum: r.contract_sum != null ? Number(r.contract_sum) : null,
    })),
    depts, totals: { debt: totalDebt, overdue: totalOverdue },
    asOf: meta.last_ok_at || null, lastTry: meta.last_sync || null, mock: meta.is_mock !== false, error: meta.last_error || null,
    filters: {
      departments: [...new Set(rows.map(r => r.department).filter(Boolean))].sort(),
      contractors: [...new Set(rows.map(r => r.contractor).filter(Boolean))].sort(),
    },
  };
}

module.exports = { ensureSchema, syncDebt, getDebtBoard };

// Модуль «Cash Flow» — 13-недельный прямой прогноз ликвидности.
// КАРКАС: приток (ожидаемые поступления) считается из РЕАЛЬНОГО Дебета 1С
// (модуль «Дебет», счёт 1210) по срокам оплаты. Отток (кредиторка/зарплата/
// налоги/прочее) пока вводится вручную на странице — подключим из 1С, когда
// появятся fact/payables и ОСВ (см. claude/onec-cashflow-data-request.md).
// Данные НЕ хранятся отдельно: прогноз выводится из зеркала Дебета на лету.
const debtMod = require('./finance-debt-calc');

const HORIZON = Number(process.env.CASHFLOW_WEEKS || 13);        // недель вперёд
const OPENING = Number(process.env.CASHFLOW_OPENING_CASH || 0);  // стартовый остаток денег (пока нет 1010/1030 из 1С)

// Понедельник недели, в которую попадает d (локально). Возвращает Date 00:00.
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0=Пн
  x.setDate(x.getDate() - dow);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function iso(d) { return d.toISOString().slice(0, 10); }
function ddmm(d) { return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0'); }

// Разбор due_date из Дебета. Отсекаем «битые» даты 1С (напр. 0204-..): год вне [2000..нынешний+6].
function parseDue(s) {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d)) return null;
  const y = d.getFullYear(), now = new Date().getFullYear();
  if (y < 2000 || y > now + 6) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function getCashflowBoard() {
  const debt = await debtMod.getDebtBoard();
  const rows = (debt.rows || []).filter(r => Number(r.debt) > 0);

  const today = new Date();
  const w0 = mondayOf(today);
  const weeks = [];
  for (let i = 0; i < HORIZON; i++) {
    const start = addDays(w0, i * 7), end = addDays(start, 6);
    weeks.push({ idx: i, start: iso(start), end: iso(end), label: ddmm(start) + '–' + ddmm(end),
      inflow: 0, _startD: start, _endD: end, items: [] });
  }
  const horizonEnd = weeks[weeks.length - 1]._endD;

  let overdueAmt = 0, overdueCnt = 0, noDueAmt = 0, noDueCnt = 0, beyondAmt = 0, beyondCnt = 0;

  for (const r of rows) {
    const amt = Math.round(Number(r.debt) || 0);
    const due = parseDue(r.due_date);
    if (!due) { noDueAmt += amt; noDueCnt++; continue; }
    let wk;
    if (due < weeks[0]._startD) { wk = weeks[0]; overdueAmt += amt; overdueCnt++; } // просрочено → ожидаем в первую неделю
    else if (due > horizonEnd) { beyondAmt += amt; beyondCnt++; continue; }         // за горизонтом 13 недель
    else wk = weeks.find(w => due >= w._startD && due <= w._endD) || weeks[0];
    wk.inflow += amt;
    wk.items.push({ contractor: r.contractor, contract: r.contract, department: r.department,
      amount: amt, due_date: r.due_date, overdue: due < weeks[0]._startD });
  }

  for (const w of weeks) {
    w.items.sort((a, b) => b.amount - a.amount);
    w.items = w.items.slice(0, 8); // верхушка для тултипа/раскрытия
    delete w._startD; delete w._endD;
  }

  const inflow13 = weeks.reduce((s, w) => s + w.inflow, 0);

  return {
    weeks,
    openingCash: OPENING,
    openingManual: true, // пока нет сальдо 1010/1030 из 1С — остаток задаётся вручную/env
    outflowCategories: [
      { key: 'payables', label: 'Поставщики (кредиторка)', pending: true },
      { key: 'payroll',  label: 'Зарплата',                pending: true },
      { key: 'taxes',    label: 'Налоги',                  pending: true },
      { key: 'other',    label: 'Прочие выплаты',          pending: true },
    ],
    totals: { inflow13 },
    overdue: { amount: overdueAmt, count: overdueCnt },
    noDue:   { amount: noDueAmt,   count: noDueCnt },
    beyond:  { amount: beyondAmt,  count: beyondCnt },
    horizonWeeks: HORIZON,
    asOf: debt.asOf || null,
    mock: debt.mock !== false,
    source: 'Дебет 1С (счёт 1210), по срокам оплаты',
  };
}

// «Обновить» = пересобрать зеркало Дебета (источник прогноза), затем вернуть доску.
async function syncCashflow() {
  const r = await debtMod.syncDebt();
  return { ok: r.ok !== false, count: (await getCashflowBoard()).weeks.length, mock: r.mock };
}

module.exports = { getCashflowBoard, syncCashflow };

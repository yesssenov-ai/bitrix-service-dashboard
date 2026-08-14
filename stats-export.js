// Выгрузка по сферам (xlsx). Для каждой сферы и компании внутри неё показывает:
//  • подписанные контракты (в разрезе 4 воронок: Приборы/Расходники/Сервис/Обучение)
//  • неподписанные сделки (в разрезе воронок И стадий P10–P80)
// Три листа: свод по сферам, свод по компаниям (широкий), детализация сделок.
const XLSX = require('xlsx');
const {
  loadEnriched, isSold, isPre, step, yr, funnelName,
  FUNNEL_ORDER, PRE_ORDER, PRE_LABELS,
} = require('./stats2-calc');

const SIGNED_LABELS = { CONTRACT: 'Контракт', EXEC: 'Исполнение', WON: 'Завершена' };
const money = n => Math.round(n || 0);

// aoa → лист с шириной колонок и денежным форматом на указанных колонках (0-based).
function sheetFrom(aoa, widths, moneyCols) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (widths) ws['!cols'] = widths.map(w => ({ wch: w }));
  const money0 = new Set(moneyCols || []);
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = 1; r <= range.e.r; r++) {
    for (const c of money0) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = ws[ref];
      if (cell && typeof cell.v === 'number') cell.z = '#,##0';
    }
  }
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  return ws;
}

async function buildSphereWorkbook(years, sphereFilter) {
  const yearsSel = (Array.isArray(years) ? years : [years]).map(y => parseInt(y, 10)).filter(Boolean);
  const sel = yearsSel.length ? [...new Set(yearsSel)].sort((a, b) => a - b) : [new Date().getFullYear()];
  const inSel = y => sel.includes(y);
  const { all } = await loadEnriched();

  // Подписанные (контракт+) по дате контракта; в работе (P10–P80) по дате создания.
  let signed = all.filter(d => isSold(d.stage) && inSel(yr(d.contractDate)));
  let pipe = all.filter(d => isPre(d.stage) && inSel(yr(d.createDate)));
  if (sphereFilter) { signed = signed.filter(d => d.industry === sphereFilter); pipe = pipe.filter(d => d.industry === sphereFilter); }

  // ── Агрегация по сфере → компании ──────────────────────────────────────────
  const spheres = {}; // industry → { companies: { key → {..} }, signedByFunnel, pipeByFunnel }
  const zeroFunnel = () => ({ Приборы: 0, Расходники: 0, Сервис: 0, Обучение: 0 });
  const ensureSph = ind => (spheres[ind] = spheres[ind] || { industry: ind, companies: {}, signed: zeroFunnel(), pipe: zeroFunnel(), signedSum: 0, pipeSum: 0 });
  const ensureCo = (sph, d) => {
    const key = d.companyId || d.company;
    if (!sph.companies[key]) sph.companies[key] = { name: d.company, signed: zeroFunnel(), pipe: zeroFunnel(), signedSum: 0, pipeSum: 0, deals: 0 };
    return sph.companies[key];
  };
  for (const d of signed) {
    const sph = ensureSph(d.industry); const co = ensureCo(sph, d); const f = d.funnel;
    if (co.signed[f] == null) co.signed[f] = 0; co.signed[f] += d.sum; co.signedSum += d.sum; co.deals++;
    if (sph.signed[f] == null) sph.signed[f] = 0; sph.signed[f] += d.sum; sph.signedSum += d.sum;
  }
  for (const d of pipe) {
    const sph = ensureSph(d.industry); const co = ensureCo(sph, d); const f = d.funnel;
    if (co.pipe[f] == null) co.pipe[f] = 0; co.pipe[f] += d.sum; co.pipeSum += d.sum; co.deals++;
    if (sph.pipe[f] == null) sph.pipe[f] = 0; sph.pipe[f] += d.sum; sph.pipeSum += d.sum;
  }
  const sphList = Object.values(spheres).sort((a, b) => b.signedSum - a.signedSum);

  // ── Лист 1: Свод по сферам ──────────────────────────────────────────────────
  const h1 = ['Сфера', 'Компаний', 'Подписано, ₸', ...FUNNEL_ORDER.map(f => 'Подп: ' + f), 'В работе, ₸', ...FUNNEL_ORDER.map(f => 'Раб: ' + f)];
  const rows1 = [h1];
  const tot = { comp: 0, signedSum: 0, pipeSum: 0, signed: zeroFunnel(), pipe: zeroFunnel() };
  for (const s of sphList) {
    rows1.push([
      s.industry, Object.keys(s.companies).length, money(s.signedSum),
      ...FUNNEL_ORDER.map(f => money(s.signed[f] || 0)),
      money(s.pipeSum), ...FUNNEL_ORDER.map(f => money(s.pipe[f] || 0)),
    ]);
    tot.comp += Object.keys(s.companies).length; tot.signedSum += s.signedSum; tot.pipeSum += s.pipeSum;
    FUNNEL_ORDER.forEach(f => { tot.signed[f] += s.signed[f] || 0; tot.pipe[f] += s.pipe[f] || 0; });
  }
  rows1.push(['ИТОГО', tot.comp, money(tot.signedSum), ...FUNNEL_ORDER.map(f => money(tot.signed[f])), money(tot.pipeSum), ...FUNNEL_ORDER.map(f => money(tot.pipe[f]))]);
  const ws1 = sheetFrom(rows1, [30, 10, 16, 14, 14, 14, 14, 16, 14, 14, 14, 14], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  // ── Лист 2: Свод по компаниям (широкий) ─────────────────────────────────────
  const h2 = ['Сфера', 'Компания', 'Подписано, ₸', ...FUNNEL_ORDER.map(f => 'Подп: ' + f), 'В работе, ₸', ...FUNNEL_ORDER.map(f => 'Раб: ' + f), 'Сделок'];
  const rows2 = [h2];
  for (const s of sphList) {
    const cos = Object.values(s.companies).sort((a, b) => (b.signedSum + b.pipeSum) - (a.signedSum + a.pipeSum));
    for (const c of cos) {
      rows2.push([
        s.industry, c.name, money(c.signedSum),
        ...FUNNEL_ORDER.map(f => money(c.signed[f] || 0)),
        money(c.pipeSum), ...FUNNEL_ORDER.map(f => money(c.pipe[f] || 0)), c.deals,
      ]);
    }
  }
  const ws2 = sheetFrom(rows2, [26, 34, 16, 13, 13, 13, 13, 16, 13, 13, 13, 13, 8], [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

  // ── Лист 3: Детализация сделок ──────────────────────────────────────────────
  const h3 = ['Сфера', 'Компания', 'Тип', 'Воронка', 'Стадия', 'Сделка', 'Сумма, ₸', 'Дата'];
  const detail = [];
  for (const d of signed) detail.push({ ind: d.industry, co: d.company, type: 'Контракт', f: d.funnel, stage: SIGNED_LABELS[step(d.stage)] || d.stage, title: d.title, sum: money(d.sum), date: d.contractDate, ord: 0 });
  for (const d of pipe) detail.push({ ind: d.industry, co: d.company, type: 'В работе', f: d.funnel, stage: PRE_LABELS[step(d.stage)] || d.stage, title: d.title, sum: money(d.sum), date: d.createDate, ord: 1 });
  detail.sort((a, b) => a.ind.localeCompare(b.ind, 'ru') || a.co.localeCompare(b.co, 'ru') || a.ord - b.ord || a.f.localeCompare(b.f, 'ru') || b.sum - a.sum);
  const rows3 = [h3, ...detail.map(d => [d.ind, d.co, d.type, d.f, d.stage, d.title, d.sum, d.date || ''])];
  const ws3 = sheetFrom(rows3, [24, 32, 10, 13, 20, 44, 15, 12], [6]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Свод по сферам');
  XLSX.utils.book_append_sheet(wb, ws2, 'Компании (свод)');
  XLSX.utils.book_append_sheet(wb, ws3, 'Детализация сделок');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), years: sel };
}

module.exports = { buildSphereWorkbook };

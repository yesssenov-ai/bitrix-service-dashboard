// Выгрузка по сферам (xlsx). Для каждой сферы и компании внутри неё показывает:
//  • подписанные контракты (в разрезе 4 воронок: Приборы/Расходники/Сервис/Обучение)
//  • неподписанные сделки (в разрезе воронок И стадий P10–P80)
// Везде — и сумма, и КОЛИЧЕСТВО сделок, из которого сумма складывается.
// Листы: свод по сферам, свод по компаниям, компании×стадии, детализация сделок.
const XLSX = require('xlsx');
const {
  loadEnriched, isSold, isPre, step, yr,
  FUNNEL_ORDER, PRE_ORDER, PRE_LABELS,
} = require('./stats2-calc');

const SIGNED_LABELS = { CONTRACT: 'Контракт', EXEC: 'Исполнение', WON: 'Завершена' };
const money = n => Math.round(n || 0);
// Разделы для листа «компании×стадии»: контракт + доконтрактные стадии.
const STAGE_ROWS = [['Контракт', 'Контракт'], ...PRE_ORDER.map(st => [st, PRE_LABELS[st]])];

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

  let signed = all.filter(d => isSold(d.stage) && inSel(yr(d.contractDate)));
  let pipe = all.filter(d => isPre(d.stage) && inSel(yr(d.createDate)));
  if (sphereFilter) { signed = signed.filter(d => d.industry === sphereFilter); pipe = pipe.filter(d => d.industry === sphereFilter); }

  const zeroF = () => ({ Приборы: 0, Расходники: 0, Сервис: 0, Обучение: 0 });
  const spheres = {};
  const ensureSph = ind => (spheres[ind] = spheres[ind] || {
    industry: ind, companies: {},
    signed: zeroF(), signedC: zeroF(), pipe: zeroF(), pipeC: zeroF(),
    signedSum: 0, signedCount: 0, pipeSum: 0, pipeCount: 0,
  });
  const ensureCo = (sph, d) => {
    const key = d.companyId || d.company;
    if (!sph.companies[key]) sph.companies[key] = {
      name: d.company, signed: zeroF(), signedC: zeroF(), pipe: zeroF(), pipeC: zeroF(),
      signedSum: 0, signedCount: 0, pipeSum: 0, pipeCount: 0, stages: {},
    };
    return sph.companies[key];
  };
  const bumpStage = (co, key, sum) => { const s = (co.stages[key] = co.stages[key] || { sum: 0, count: 0 }); s.sum += sum; s.count++; };

  for (const d of signed) {
    const sph = ensureSph(d.industry); const co = ensureCo(sph, d); const f = d.funnel;
    co.signed[f] = (co.signed[f] || 0) + d.sum; co.signedC[f] = (co.signedC[f] || 0) + 1; co.signedSum += d.sum; co.signedCount++;
    sph.signed[f] = (sph.signed[f] || 0) + d.sum; sph.signedC[f] = (sph.signedC[f] || 0) + 1; sph.signedSum += d.sum; sph.signedCount++;
    bumpStage(co, 'Контракт', d.sum);
  }
  for (const d of pipe) {
    const sph = ensureSph(d.industry); const co = ensureCo(sph, d); const f = d.funnel;
    co.pipe[f] = (co.pipe[f] || 0) + d.sum; co.pipeC[f] = (co.pipeC[f] || 0) + 1; co.pipeSum += d.sum; co.pipeCount++;
    sph.pipe[f] = (sph.pipe[f] || 0) + d.sum; sph.pipeC[f] = (sph.pipeC[f] || 0) + 1; sph.pipeSum += d.sum; sph.pipeCount++;
    bumpStage(co, step(d.stage), d.sum);
  }
  const sphList = Object.values(spheres).sort((a, b) => b.signedSum - a.signedSum);

  // ── Лист 1: Свод по сферам (сумма + количество в каждой воронке) ─────────────
  const h1 = ['Сфера', 'Компаний', 'Подписано, ₸', 'Подписано, сделок',
    ...FUNNEL_ORDER.flatMap(f => ['Подп ' + f + ', ₸', 'Подп ' + f + ', шт']),
    'В работе, ₸', 'В работе, сделок',
    ...FUNNEL_ORDER.flatMap(f => ['Раб ' + f + ', ₸', 'Раб ' + f + ', шт'])];
  const rows1 = [h1];
  const mkFunnelPairs = (sumObj, cntObj) => FUNNEL_ORDER.flatMap(f => [money(sumObj[f] || 0), cntObj[f] || 0]);
  const tot = { comp: 0, sSum: 0, sCnt: 0, pSum: 0, pCnt: 0, s: zeroF(), sC: zeroF(), p: zeroF(), pC: zeroF() };
  for (const s of sphList) {
    rows1.push([s.industry, Object.keys(s.companies).length, money(s.signedSum), s.signedCount,
      ...mkFunnelPairs(s.signed, s.signedC), money(s.pipeSum), s.pipeCount, ...mkFunnelPairs(s.pipe, s.pipeC)]);
    tot.comp += Object.keys(s.companies).length; tot.sSum += s.signedSum; tot.sCnt += s.signedCount; tot.pSum += s.pipeSum; tot.pCnt += s.pipeCount;
    FUNNEL_ORDER.forEach(f => { tot.s[f] += s.signed[f] || 0; tot.sC[f] += s.signedC[f] || 0; tot.p[f] += s.pipe[f] || 0; tot.pC[f] += s.pipeC[f] || 0; });
  }
  rows1.push(['ИТОГО', tot.comp, money(tot.sSum), tot.sCnt, ...mkFunnelPairs(tot.s, tot.sC), money(tot.pSum), tot.pCnt, ...mkFunnelPairs(tot.p, tot.pC)]);
  const w1 = [30, 10, 15, 14, 13, 8, 13, 8, 13, 8, 13, 8, 15, 14, 13, 8, 13, 8, 13, 8, 13, 8];
  const money1 = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]; // ₸-колонки
  const ws1 = sheetFrom(rows1, w1, money1);

  // ── Лист 2: Свод по компаниям (сумма по воронкам + количества) ───────────────
  const h2 = ['Сфера', 'Компания', 'Подписано, ₸', 'Подписано, сделок', ...FUNNEL_ORDER.map(f => 'Подп: ' + f),
    'В работе, ₸', 'В работе, сделок', ...FUNNEL_ORDER.map(f => 'Раб: ' + f), 'Всего сделок'];
  const rows2 = [h2];
  for (const s of sphList) {
    const cos = Object.values(s.companies).sort((a, b) => (b.signedSum + b.pipeSum) - (a.signedSum + a.pipeSum));
    for (const c of cos) {
      rows2.push([s.industry, c.name, money(c.signedSum), c.signedCount, ...FUNNEL_ORDER.map(f => money(c.signed[f] || 0)),
        money(c.pipeSum), c.pipeCount, ...FUNNEL_ORDER.map(f => money(c.pipe[f] || 0)), c.signedCount + c.pipeCount]);
    }
  }
  const ws2 = sheetFrom(rows2, [26, 34, 15, 14, 13, 13, 13, 13, 15, 14, 13, 13, 13, 13, 10], [2, 4, 5, 6, 7, 8, 10, 11, 12, 13]);

  // ── Лист 3: Компании × стадии (контракт + каждая доконтрактная стадия) ───────
  const h3 = ['Сфера', 'Компания', 'Раздел', 'Сумма, ₸', 'Сделок'];
  const rows3 = [h3];
  for (const s of sphList) {
    const cos = Object.values(s.companies).sort((a, b) => (b.signedSum + b.pipeSum) - (a.signedSum + a.pipeSum));
    for (const c of cos) {
      for (const [key, label] of STAGE_ROWS) {
        const st = c.stages[key];
        if (!st || !st.count) continue;
        rows3.push([s.industry, c.name, label, money(st.sum), st.count]);
      }
    }
  }
  const ws3 = sheetFrom(rows3, [24, 34, 22, 15, 9], [3]);

  // ── Лист 4: Детализация сделок ──────────────────────────────────────────────
  const h4 = ['Сфера', 'Компания', 'Тип', 'Воронка', 'Стадия', 'Сделка', 'Сумма, ₸', 'Дата'];
  const detail = [];
  for (const d of signed) detail.push({ ind: d.industry, co: d.company, type: 'Контракт', f: d.funnel, stage: SIGNED_LABELS[step(d.stage)] || d.stage, title: d.title, sum: money(d.sum), date: d.contractDate, ord: 0 });
  for (const d of pipe) detail.push({ ind: d.industry, co: d.company, type: 'В работе', f: d.funnel, stage: PRE_LABELS[step(d.stage)] || d.stage, title: d.title, sum: money(d.sum), date: d.createDate, ord: 1 });
  detail.sort((a, b) => a.ind.localeCompare(b.ind, 'ru') || a.co.localeCompare(b.co, 'ru') || a.ord - b.ord || a.f.localeCompare(b.f, 'ru') || b.sum - a.sum);
  const rows4 = [h4, ...detail.map(d => [d.ind, d.co, d.type, d.f, d.stage, d.title, d.sum, d.date || ''])];
  const ws4 = sheetFrom(rows4, [24, 32, 10, 13, 20, 44, 15, 12], [6]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, 'Свод по сферам');
  XLSX.utils.book_append_sheet(wb, ws2, 'Компании (свод)');
  XLSX.utils.book_append_sheet(wb, ws3, 'Компании × стадии');
  XLSX.utils.book_append_sheet(wb, ws4, 'Детализация сделок');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), years: sel };
}

module.exports = { buildSphereWorkbook };

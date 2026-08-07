// ─────────────────────────────────────────────────────────────────────────────
// Operational module export — PDF (pdfmake, styled like the dashboard) and
// XLSX (SheetJS, clean data). Two shapes each:
//   • simple   — funnel summary + detail table
//   • detailed — the above + per-deal breakdown (процессы/задачи/комментарии/БП)
// Exports exactly the rows passed in (the dashboard's current filtered set).
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');
const PdfPrinter = require('pdfmake/src/printer');
const XLSX = require('xlsx');

const FONT_DIR = path.join(__dirname, 'public', 'assets', 'fonts');
// DejaVu Sans — full Cyrillic + symbols (●, ✓, ⚠). Shipped in the repo.
const fonts = {
  Deja: {
    normal: path.join(FONT_DIR, 'DejaVuSans.ttf'),
    bold: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
    italics: path.join(FONT_DIR, 'DejaVuSans.ttf'),
    bolditalics: path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
  },
};

const BRAND = '#C53B2F';
const HEAD = '#20242e';
const LINE = '#e2e5ea';
const DIMTXT = '#6b7280';

const money = n => Math.round(Number(n) || 0).toLocaleString('ru-RU');
const fmtDate = d => { if (!d) return ''; const p = String(d).slice(0, 10).split('-'); return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : String(d); };
// Keep the time as stored by Bitrix (its local offset), no timezone math.
const fmtDateTime = v => { if (!v) return ''; const m = String(v).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/); return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : fmtDate(v); };

const FLAG_ORDER = ['red', 'overdue', 'overdue-task', 'open-bp', 'late-ship', 'stale'];
const FLAG_LABEL = { red: 'Красный флаг', overdue: 'Просрочена поставка', 'overdue-task': 'Просроч. задачи', 'open-bp': 'Незаверш. БП', 'late-ship': 'Отгрузка позже срока', stale: 'Завис >14 дн' };
const FLAG_COLOR = { red: '#C53B2F', overdue: '#ff5752', 'overdue-task': '#ff8a3d', 'open-bp': '#8b5cf6', 'late-ship': '#c98bff', stale: '#e0a940' };
function primaryFlag(flags) { for (const f of FLAG_ORDER) if ((flags || []).includes(f)) return f; return null; }

const COLS = [
  { key: 'flag', title: '', w: 12 },
  { key: 'stageName', title: 'Стадия', w: 62 },
  { key: 'company', title: 'Компания', w: 90 },
  { key: 'contract', title: '№ договора / Название', w: '*' },
  { key: 'deliveryBy', title: 'Поставка\nпо дог.', w: 44 },
  { key: 'factoryShip', title: 'Отгрузка\nзавод', w: 44 },
  { key: 'diffDays', title: 'Разн.', w: 26 },
  { key: 'manager', title: 'Менеджер', w: 62 },
  { key: 'engineer', title: 'Инженер', w: 58 },
  { key: 'payFactory', title: 'Оплата\nзавод', w: 54 },
  { key: 'payClient', title: 'Оплата\nклиент', w: 54 },
  { key: 'opportunity', title: 'Сумма', w: 56 },
];

// ── PDF ──────────────────────────────────────────────────────────────────────
function funnelBlock(board) {
  const cells = (board.funnel && board.funnel.cells) || [];
  if (!cells.length) return null;
  const header = cells.map(c => ({ text: c.name, style: 'fName', fillColor: HEAD }));
  const sums = cells.map(c => ({ text: money(c.sum), style: 'fSum' }));
  const counts = cells.map(c => ({ text: `${c.count} шт.`, style: 'fCount' }));
  return {
    table: { widths: cells.map(() => '*'), body: [header, sums, counts] },
    layout: { hLineColor: () => LINE, vLineColor: () => LINE, hLineWidth: () => 0.5, vLineWidth: () => 0.5 },
    margin: [0, 0, 0, 14],
  };
}

function tableBody(rows) {
  const body = [COLS.map(c => ({ text: c.title, style: 'th' }))];
  rows.forEach(r => {
    const pf = primaryFlag(r.flags);
    const diff = r.diffDays == null ? '' : `${r.onTime ? '✓ ' : ''}${r.diffDays}`;
    body.push([
      { text: pf ? '●' : '', color: pf ? FLAG_COLOR[pf] : '#fff', alignment: 'center', fontSize: 9 },
      { text: r.stageName || '', color: r.stageColor || '#333', bold: true, fontSize: 7 },
      { text: r.company || '', fontSize: 7 },
      { text: [{ text: (r.contractNo || ('#' + r.id)), bold: true }, { text: r.title ? '\n' + r.title : '', color: DIMTXT }], fontSize: 7 },
      { text: fmtDate(r.deliveryBy), fontSize: 7, alignment: 'center', color: (r.flags || []).includes('overdue') ? '#c0392b' : '#333' },
      { text: fmtDate(r.factoryShip), fontSize: 7, alignment: 'center' },
      { text: diff, fontSize: 7, alignment: 'center', color: r.onTime === false ? '#c0392b' : (r.onTime ? '#1e8e5a' : '#333') },
      { text: r.manager || '', fontSize: 7 },
      { text: r.engineer || '', fontSize: 7 },
      { text: r.payFactory || '', fontSize: 6.5 },
      { text: r.payClient || '', fontSize: 6.5 },
      { text: money(r.opportunity), fontSize: 7, alignment: 'right', bold: true },
    ]);
  });
  return body;
}

function detailedBlocks(rows, detailsMap) {
  const out = [{ text: 'Детализация по сделкам', style: 'h2', margin: [0, 16, 0, 8], pageBreak: 'before' }];
  rows.forEach(r => {
    const d = detailsMap[r.id] || {};
    const parts = [
      { text: `${r.company || ''} — ${r.contractNo || ('#' + r.id)}`, bold: true, fontSize: 10, margin: [0, 8, 0, 1] },
      { text: `${r.title || ''}`, color: DIMTXT, fontSize: 8, margin: [0, 0, 0, 4] },
      { text: `Стадия: ${r.stageName || ''}   ·   Менеджер: ${r.manager || '—'}   ·   Сумма: ${money(r.opportunity)}`, fontSize: 8, margin: [0, 0, 0, 6] },
    ];
    const procs = (d.processes || []).map(p => ({ text: `${'    '.repeat(p.depth || 0)}• ${p.entityName}: ${p.title} — ${p.stageName}${p.responsible ? ' (' + p.responsible + ')' : ''}`, fontSize: 8, margin: [0, 0, 0, 1] }));
    const tasks = (d.tasks || []).map(t => ({ text: `• ${t.title}${t.responsible ? ' — ' + t.responsible : ''}${t.deadline ? ' · до ' + fmtDate(t.deadline) : ''}${t.overdue ? ' ⚠' : ''}`, fontSize: 8, margin: [0, 0, 0, 1] }));
    const cmts = (d.comments || []).map(c => ({ text: `${fmtDateTime(c.date)} · ${c.author}: ${c.text}`, fontSize: 8, color: '#333', margin: [0, 0, 0, 1] }));
    const autos = (d.automations || []).flatMap(a => (a.steps && a.steps.length ? a.steps.map(s => ({ text: `• ${s.name} → Выполняется${s.waitsFor && s.waitsFor.length ? ' → ждёт ' + s.waitsFor.join(', ') : ''}`, fontSize: 8, margin: [0, 0, 0, 1] })) : [{ text: `• ${a.name} → выполняется (авто)`, fontSize: 8, margin: [0, 0, 0, 1] }]));
    const section = (title, arr) => arr.length ? [{ text: title, bold: true, fontSize: 8.5, color: BRAND, margin: [0, 4, 0, 2] }, ...arr] : [];
    out.push({
      stack: [
        ...parts,
        ...section('Смарт-процессы', procs),
        ...section('Задачи', tasks),
        ...section('Автоматизации', autos),
        ...section('Комментарии', cmts),
      ],
      margin: [0, 0, 0, 8],
      unbreakable: false,
    });
    out.push({ canvas: [{ type: 'line', x1: 0, y1: 0, x2: 760, y2: 0, lineWidth: 0.5, lineColor: LINE }], margin: [0, 2, 0, 2] });
  });
  return out;
}

function buildPdf({ board, rows, type, meta }) {
  const printer = new PdfPrinter(fonts);
  const content = [
    { columns: [
      { text: [{ text: 'ProLab', bold: true, fontSize: 15 }, { text: 'Support', bold: true, fontSize: 15, color: BRAND }], width: '*' },
      { text: `Выгружено: ${meta.date}`, alignment: 'right', fontSize: 8, color: DIMTXT, margin: [0, 4, 0, 0] },
    ] },
    { text: 'Реализация · ход исполнения сделок', bold: true, fontSize: 13, margin: [0, 2, 0, 2] },
    { text: `${meta.filterText}${meta.filterText ? '   ·   ' : ''}Сделок: ${rows.length}   ·   Сумма: ${money(rows.reduce((a, r) => a + r.opportunity, 0))} ₸`, fontSize: 8.5, color: DIMTXT, margin: [0, 0, 0, 12] },
  ];
  const fb = funnelBlock(board);
  if (fb) content.push(fb);
  content.push({
    table: { headerRows: 1, widths: COLS.map(c => c.w), body: tableBody(rows), dontBreakRows: true },
    layout: {
      fillColor: (rowIndex) => (rowIndex === 0 ? HEAD : (rowIndex % 2 === 0 ? '#f6f7f9' : null)),
      hLineColor: () => LINE, vLineColor: () => LINE, hLineWidth: () => 0.5, vLineWidth: () => 0.5,
      paddingTop: () => 3, paddingBottom: () => 3, paddingLeft: () => 4, paddingRight: () => 4,
    },
  });
  if (type === 'detailed') content.push(...detailedBlocks(rows, meta.detailsMap || {}));

  const docDefinition = {
    pageSize: 'A4', pageOrientation: 'landscape', pageMargins: [24, 24, 24, 30],
    defaultStyle: { font: 'Deja', fontSize: 8 },
    footer: (cur, total) => ({ text: `${cur} / ${total}`, alignment: 'center', fontSize: 7, color: DIMTXT, margin: [0, 6, 0, 0] }),
    content,
    styles: {
      th: { bold: true, color: 'white', fontSize: 7, alignment: 'left' },
      h2: { bold: true, fontSize: 12, color: BRAND },
      fName: { color: 'white', bold: true, fontSize: 7.5, alignment: 'center' },
      fSum: { bold: true, fontSize: 9.5, alignment: 'center' },
      fCount: { color: DIMTXT, fontSize: 7.5, alignment: 'center' },
    },
  };

  return new Promise((resolve, reject) => {
    const doc = printer.createPdfKitDocument(docDefinition);
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

// ── XLSX ─────────────────────────────────────────────────────────────────────
function flagLabel(flags) { const f = primaryFlag(flags); return f ? FLAG_LABEL[f] : ''; }

function buildXlsx({ board, rows, type, meta }) {
  const wb = XLSX.utils.book_new();

  // Main sheet: funnel summary on top, then the detail table.
  const aoa = [];
  aoa.push(['ProLabSupport · Реализация — ход исполнения сделок']);
  aoa.push([`Выгружено: ${meta.date}`, meta.filterText || '']);
  aoa.push([`Сделок: ${rows.length}`, `Сумма: ${rows.reduce((a, r) => a + r.opportunity, 0)}`]);
  aoa.push([]);
  const cells = (board.funnel && board.funnel.cells) || [];
  if (cells.length) {
    aoa.push(['Воронка', 'Сумма', 'Количество']);
    cells.forEach(c => aoa.push([c.name, c.sum, c.count]));
    aoa.push([]);
  }
  const header = ['Флаг', 'Стадия', 'Компания', '№ договора', 'Название', 'Поставка по дог.', 'Отгрузка завод', 'Разница (дн.)', 'Менеджер', 'Инженер', 'Оплата завод', 'Оплата клиент', 'Сумма'];
  aoa.push(header);
  rows.forEach(r => aoa.push([
    flagLabel(r.flags), r.stageName || '', r.company || '', r.contractNo || ('#' + r.id), r.title || '',
    fmtDate(r.deliveryBy), fmtDate(r.factoryShip), r.diffDays == null ? '' : r.diffDays,
    r.manager || '', r.engineer || '', r.payFactory || '', r.payClient || '', r.opportunity || 0,
  ]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [16, 20, 26, 20, 40, 14, 14, 11, 20, 18, 22, 22, 16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Сделки');

  if (type === 'detailed') {
    const dm = meta.detailsMap || {};
    const procRows = [['Сделка', 'Компания', 'Тип процесса', 'Название', 'Стадия', 'Ответственный']];
    const taskRows = [['Сделка', 'Компания', 'Задача', 'Ответственный', 'Дедлайн', 'Просрочена']];
    const cmtRows = [['Сделка', 'Компания', 'Дата', 'Автор', 'Комментарий']];
    const autoRows = [['Сделка', 'Компания', 'Автоматизация / шаг', 'Статус', 'Ждёт']];
    rows.forEach(r => {
      const d = dm[r.id] || {};
      const label = r.contractNo || ('#' + r.id);
      (d.processes || []).forEach(p => procRows.push([label, r.company || '', p.entityName, p.title, p.stageName, p.responsible || '']));
      (d.tasks || []).forEach(t => taskRows.push([label, r.company || '', t.title, t.responsible || '', fmtDate(t.deadline), t.overdue ? 'да' : '']));
      (d.comments || []).forEach(c => cmtRows.push([label, r.company || '', fmtDateTime(c.date), c.author, c.text]));
      (d.automations || []).forEach(a => {
        if (a.steps && a.steps.length) a.steps.forEach(s => autoRows.push([label, r.company || '', s.name, 'Выполняется', (s.waitsFor || []).join(', ')]));
        else autoRows.push([label, r.company || '', a.name, 'Выполняется (авто)', '']);
      });
    });
    const add = (data, name, cols) => { const s = XLSX.utils.aoa_to_sheet(data); s['!cols'] = cols.map(w => ({ wch: w })); XLSX.utils.book_append_sheet(wb, s, name); };
    add(procRows, 'Смарт-процессы', [18, 24, 22, 30, 22, 22]);
    add(taskRows, 'Задачи', [18, 24, 40, 22, 14, 10]);
    add(autoRows, 'Автоматизации', [18, 24, 40, 20, 24]);
    add(cmtRows, 'Комментарии', [18, 24, 14, 20, 60]);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildPdf, buildXlsx };

const path = require('path');
const PdfPrinter = require('pdfmake/src/printer');
const { assembleKpData } = require('./kp-doc-data');
const {
  INTRO_PARAGRAPHS, INTRO_ADVANTAGES_HEADING, INTRO_ADVANTAGES, INTRO_PARAGRAPHS_2,
  TABLE_HEADING, CLOSING_PARAGRAPHS, SIGNATURE_TITLE, SIGNATURE_NAME,
} = require('./kp-boilerplate');

const FONT_DIR = path.join(__dirname, 'public', 'assets', 'fonts');
const fonts = {
  PTSans: {
    normal: path.join(FONT_DIR, 'PTSans-Regular.ttf'),
    bold: path.join(FONT_DIR, 'PTSans-Bold.ttf'),
    italics: path.join(FONT_DIR, 'PTSans-Regular.ttf'),
    bolditalics: path.join(FONT_DIR, 'PTSans-Bold.ttf'),
  },
};

const BRAND_RED = '#C53B2F';
const money = n => (n == null ? '' : n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function buildTableBody(data) {
  const body = [[
    { text: '№', style: 'thead' }, { text: 'Наименование', style: 'thead' }, { text: 'Кол-во', style: 'thead' },
    { text: 'Цена, USD без НДС', style: 'thead' }, { text: 'Итоговая цена, USD без НДС', style: 'thead' },
  ]];

  data.modules.forEach(mod => {
    body.push([
      { text: mod.no, style: 'moduleRow' }, { text: mod.name, style: 'moduleRow', colSpan: 4 }, {}, {}, {},
    ]);
    mod.sections.forEach(sec => {
      if (sec.no) body.push([
        { text: sec.no, style: 'sectionRow' }, { text: sec.name, style: 'sectionRow', colSpan: 4 }, {}, {}, {},
      ]);
      sec.items.forEach(it => body.push([
        { text: it.no, style: 'cell' },
        { text: it.name, style: 'cell' },
        { text: String(it.qty), style: 'cellCenter' },
        { text: it.included ? 'Включено' : money(it.unitPrice), style: 'cellRight' },
        { text: it.included ? 'Включено' : money(it.lineTotal), style: 'cellRight' },
      ]));
    });
    const hasPriced = mod.sections.some(sec => sec.items.some(it => !it.included));
    if (hasPriced) {
      body.push([
        { text: `Итого по разделу «${mod.name}», USD без НДС`, style: 'subtotalRow', colSpan: 4, alignment: 'right' }, {}, {}, {},
        { text: money(mod.moduleTotal), style: 'subtotalRow', alignment: 'right' },
      ]);
    }
  });
  body.push([
    { text: 'Общая сумма, USD без НДС', style: 'grandRow', colSpan: 4, alignment: 'right' }, {}, {}, {},
    { text: money(data.grandTotal), style: 'grandRow', alignment: 'right' },
  ]);
  return body;
}

async function generateKpPdf(kpRequestId) {
  const data = await assembleKpData(kpRequestId);
  const printer = new PdfPrinter(fonts);

  const docDefinition = {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'PTSans', fontSize: 10 },
    content: [
      { text: [{ text: 'ProLab', bold: true, fontSize: 16 }, { text: 'Support', bold: true, fontSize: 16, color: BRAND_RED }], alignment: 'center', margin: [0, 0, 0, 4] },
      { text: 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ', bold: true, fontSize: 14, alignment: 'center', margin: [0, 0, 0, 16] },
      { text: `Дата: ${data.dateStr}`, margin: [0, 0, 0, 6] },
      { text: `Получатель: ${data.clientName}`, bold: true, margin: [0, 0, 0, 10] },
      ...INTRO_PARAGRAPHS.map(t => ({ text: t, margin: [0, 0, 0, 8] })),
      { text: INTRO_ADVANTAGES_HEADING, bold: true, margin: [0, 4, 0, 4] },
      { ul: INTRO_ADVANTAGES, margin: [0, 0, 0, 10] },
      ...INTRO_PARAGRAPHS_2.map(t => ({ text: t, margin: [0, 0, 0, 8] })),
      { text: `Получатель: ${data.clientName}`, bold: true, margin: [0, 6, 0, 6] },
      { text: TABLE_HEADING, bold: true, fontSize: 12, margin: [0, 6, 0, 10] },
      {
        table: { headerRows: 1, widths: [28, '*', 32, 60, 68], body: buildTableBody(data) },
        layout: {
          fillColor: (rowIndex, node) => (rowIndex === 0 ? BRAND_RED : null),
          hLineColor: () => '#dddddd', vLineColor: () => '#dddddd',
        },
      },
      { text: '', margin: [0, 14, 0, 0] },
      ...CLOSING_PARAGRAPHS.map(t => ({ text: t, margin: [0, 0, 0, 8] })),
      { columns: [{ text: SIGNATURE_TITLE, width: '*' }, { text: SIGNATURE_NAME, width: 'auto' }], margin: [0, 20, 0, 0] },
    ],
    styles: {
      thead: { bold: true, color: 'white', fillColor: BRAND_RED, fontSize: 9, alignment: 'center' },
      moduleRow: { bold: true, fillColor: '#efefef', fontSize: 10 },
      sectionRow: { bold: true, fillColor: '#f8f8f8', fontSize: 9.5 },
      cell: { fontSize: 9 },
      cellCenter: { fontSize: 9, alignment: 'center' },
      cellRight: { fontSize: 9, alignment: 'right' },
      subtotalRow: { bold: true, fillColor: '#efefef', fontSize: 9.5 },
      grandRow: { bold: true, fillColor: '#dddddd', fontSize: 10.5 },
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

module.exports = { generateKpPdf };

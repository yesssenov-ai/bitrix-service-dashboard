const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  AlignmentType, HeadingLevel, ShadingType, VerticalAlign,
} = require('docx');
const { assembleKpData } = require('./kp-doc-data');
const {
  INTRO_PARAGRAPHS, INTRO_ADVANTAGES_HEADING, INTRO_ADVANTAGES, INTRO_PARAGRAPHS_2,
  TABLE_HEADING, CLOSING_PARAGRAPHS, SIGNATURE_TITLE, SIGNATURE_NAME,
} = require('./kp-boilerplate');

const BRAND_RED = 'C53B2F';
const COL_WIDTHS = [900, 4600, 900, 1400, 1500]; // DXA, sums to 9300 (~6.45")
const money = n => (n == null ? '' : n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function bodyPara(text, opts = {}) {
  return new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text, size: 21, ...opts })] });
}
function bulletPara(text) {
  return new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '•  ' + text, size: 21 })] });
}

function headerCell(text, width) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: BRAND_RED },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
    children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 19 })] })],
  });
}
function dataCell(text, width, opts = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({ alignment: opts.align || AlignmentType.LEFT, children: [new TextRun({ text: String(text ?? ''), bold: !!opts.bold, size: 19 })] })],
  });
}
function moduleHeaderRow(no, name) {
  return new TableRow({
    children: [0,1,2,3,4].map((i) => new TableCell({
      width: { size: COL_WIDTHS[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: 'EFEFEF' },
      children: i === 0
        ? [new Paragraph({ children: [new TextRun({ text: String(no), bold: true, size: 19 })] })]
        : i === 1
        ? [new Paragraph({ children: [new TextRun({ text: name, bold: true, size: 19 })] })]
        : [new Paragraph({ children: [] })],
    })),
  });
}
function sectionHeaderRow(no, name) {
  return new TableRow({
    children: [0,1,2,3,4].map((i) => new TableCell({
      width: { size: COL_WIDTHS[i], type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: 'F8F8F8' },
      children: i === 0
        ? [new Paragraph({ children: [new TextRun({ text: String(no), bold: true, size: 19 })] })]
        : i === 1
        ? [new Paragraph({ children: [new TextRun({ text: name, bold: true, size: 19 })] })]
        : [new Paragraph({ children: [] })],
    })),
  });
}
function itemRow(item) {
  return new TableRow({
    children: [
      dataCell(item.no, COL_WIDTHS[0]),
      dataCell(item.name, COL_WIDTHS[1]),
      dataCell(item.qty, COL_WIDTHS[2], { align: AlignmentType.CENTER }),
      dataCell(item.included ? 'Включено' : money(item.unitPrice), COL_WIDTHS[3], { align: AlignmentType.RIGHT }),
      dataCell(item.included ? 'Включено' : money(item.lineTotal), COL_WIDTHS[4], { align: AlignmentType.RIGHT }),
    ],
  });
}
function subtotalRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({ width: { size: COL_WIDTHS[0]+COL_WIDTHS[1]+COL_WIDTHS[2]+COL_WIDTHS[3], type: WidthType.DXA }, columnSpan: 4,
        shading: { type: ShadingType.CLEAR, fill: 'EFEFEF' },
        children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: label, bold: true, size: 19 })] })] }),
      dataCell(money(value), COL_WIDTHS[4], { align: AlignmentType.RIGHT, bold: true }),
    ],
  });
}

async function generateKpDocx(kpRequestId) {
  const data = await assembleKpData(kpRequestId);

  const tableRows = [
    new TableRow({
      tableHeader: true,
      children: [
        headerCell('№', COL_WIDTHS[0]), headerCell('Наименование', COL_WIDTHS[1]), headerCell('Кол-во', COL_WIDTHS[2]),
        headerCell('Цена, USD без НДС', COL_WIDTHS[3]), headerCell('Итоговая цена, USD без НДС', COL_WIDTHS[4]),
      ],
    }),
  ];

  data.modules.forEach(mod => {
    tableRows.push(moduleHeaderRow(mod.no, mod.name));
    mod.sections.forEach(sec => {
      if (sec.no) tableRows.push(sectionHeaderRow(sec.no, sec.name));
      sec.items.forEach(it => tableRows.push(itemRow(it)));
    });
    const hasPriced = mod.sections.some(sec => sec.items.some(it => !it.included));
    if (hasPriced) tableRows.push(subtotalRow(`Итого по разделу «${mod.name}», USD без НДС`, mod.moduleTotal));
  });
  tableRows.push(subtotalRow('Общая сумма, USD без НДС', data.grandTotal));

  const table = new Table({ width: { size: 9300, type: WidthType.DXA }, columnWidths: COL_WIDTHS, rows: tableRows });

  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: 'ProLab', bold: true, size: 32 }), new TextRun({ text: 'Support', bold: true, size: 32, color: BRAND_RED })] }),
        new Paragraph({ alignment: AlignmentType.CENTER, heading: HeadingLevel.HEADING_1, spacing: { after: 280 }, children: [new TextRun({ text: 'КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ' })] }),
        bodyPara(`Дата: ${data.dateStr}`),
        bodyPara(`Получатель: ${data.clientName}`, { bold: true }),
        ...INTRO_PARAGRAPHS.map(t => bodyPara(t)),
        new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: INTRO_ADVANTAGES_HEADING, bold: true, size: 21 })] }),
        ...INTRO_ADVANTAGES.map(t => bulletPara(t)),
        new Paragraph({ spacing: { after: 200 } }),
        ...INTRO_PARAGRAPHS_2.map(t => bodyPara(t)),
        new Paragraph({ spacing: { after: 100 }, children: [new TextRun({ text: `Получатель: ${data.clientName}`, bold: true, size: 21 })] }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 100, after: 200 }, children: [new TextRun({ text: TABLE_HEADING })] }),
        table,
        new Paragraph({ spacing: { before: 260, after: 160 } }),
        ...CLOSING_PARAGRAPHS.map(t => bodyPara(t)),
        new Paragraph({ spacing: { before: 300 }, children: [
          new TextRun({ text: SIGNATURE_TITLE + '\t\t\t\t' }),
          new TextRun({ text: SIGNATURE_NAME }),
        ] }),
      ],
    }],
  });

  return Packer.toBuffer(doc);
}

module.exports = { generateKpDocx };

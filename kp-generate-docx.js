const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');
const { assembleKpData } = require('./kp-doc-data');

const TPL_DIR = path.join(__dirname, 'kp-template');
const TEMPLATE_DOCX = path.join(TPL_DIR, 'kp-template.docx');

const rowTpl = {
  module: fs.readFileSync(path.join(TPL_DIR, 'tpl_module.xml'), 'utf-8'),
  section: fs.readFileSync(path.join(TPL_DIR, 'tpl_section.xml'), 'utf-8'),
  item: fs.readFileSync(path.join(TPL_DIR, 'tpl_item.xml'), 'utf-8'),
  subtotal: fs.readFileSync(path.join(TPL_DIR, 'tpl_subtotal.xml'), 'utf-8'),
  grandtotal: fs.readFileSync(path.join(TPL_DIR, 'tpl_grandtotal.xml'), 'utf-8'),
};

const money = n => (n == null ? '' : n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Escapes text for safe insertion into a <w:t> element
function xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function fillRow(template, values) {
  let out = template;
  for (const [key, val] of Object.entries(values)) {
    out = out.replace(`__${key}__`, xmlEsc(val));
  }
  return out;
}

function buildTableRowsXml(data) {
  let xml = '';
  data.modules.forEach(mod => {
    xml += fillRow(rowTpl.module, { LABEL: `${mod.no}. ${mod.name}` });
    mod.sections.forEach(sec => {
      if (sec.no) xml += fillRow(rowTpl.section, { LABEL: `${sec.no} ${sec.name}` });
      sec.items.forEach(it => {
        xml += fillRow(rowTpl.item, {
          NO: it.no, NAME: it.name, QTY: String(it.qty),
          PRICE: it.included ? 'Включено' : money(it.unitPrice),
          TOTAL: it.included ? 'Включено' : money(it.lineTotal),
        });
      });
    });
    const hasPriced = mod.sections.some(sec => sec.items.some(it => !it.included));
    if (hasPriced) {
      xml += fillRow(rowTpl.subtotal, {
        LABEL: `Итого по разделу «${mod.name}», USD без НДС`,
        VALUE: money(mod.moduleTotal),
      });
    }
  });
  xml += fillRow(rowTpl.grandtotal, { LABEL: 'Общая сумма, USD без НДС', VALUE: money(data.grandTotal) });
  return xml;
}

async function generateKpDocx(kpRequestId) {
  const data = await assembleKpData(kpRequestId);
  const tableRowsXml = buildTableRowsXml(data);

  const zip = new PizZip(fs.readFileSync(TEMPLATE_DOCX));
  let doc = zip.file('word/document.xml').asText();

  doc = doc.split('__TABLE_ROWS__').join(tableRowsXml);
  doc = doc.split('{clientName}').join(xmlEsc(data.clientName));
  doc = doc.split('{date}').join(xmlEsc(data.dateStr));

  zip.file('word/document.xml', doc);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { generateKpDocx };

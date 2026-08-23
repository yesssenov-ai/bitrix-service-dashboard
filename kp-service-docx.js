// Генерация сервисного КП строго 1:1 по фирменному DOCX-шаблону клиента
// (КП_service.docx: логотип, фото команды, иконки услуг, орнамент, QR, печать,
// подпись — всё сохранено). Подставляем только переменный текст через PizZip
// (как в модуле МЛК). Текст лежит в графических блоках и продублирован
// (Choice+Fallback) — заменяем все вхождения токена сразу.
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATE = path.join(__dirname, 'kp-service-template', 'service-brand.docx');

const money = n => (Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const arr = v => Array.isArray(v) ? v.filter(x => String(x || '').trim()) : (v ? String(v).split('\n').map(s => s.trim()).filter(Boolean) : []);

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// экранируем и переносы строк -> <w:br/> внутри одного run
function xmlMultiline(s) {
  return xmlEsc(s).split('\n').join('</w:t><w:br/><w:t xml:space="preserve">');
}

function totalLine(d) {
  const vat = (d.vatMode === 'без') ? 'без учета' : 'с учетом';
  return `Итого ${vat} НДС: ${money(d.total)} ${d.currency || 'тенге'}.`;
}
function conditionsText(d) {
  let c = String(d.conditions || '').trim();
  if (d.term && String(d.term).trim()) c += (c ? '\n' : '') + 'Срок оказания услуги: ' + String(d.term).trim();
  return c;
}

// buildServiceKpDocx(d) -> Promise<Buffer>
function buildServiceKpDocx(d) {
  return new Promise((resolve, reject) => {
    try {
      const zip = new PizZip(fs.readFileSync(TEMPLATE, 'binary'));
      let xml = zip.file('word/document.xml').asText();
      const equipment = arr(d.equipment).map(e => '• ' + e).join('\n');
      const scope = arr(d.scope).map((s, i) => (i + 1) + '. ' + s).join('\n');
      const repl = {
        '{{DATE}}': xmlEsc(d.date || ''),
        '{{CLIENT}}': xmlMultiline(d.client || ''),
        '{{TITLE}}': xmlMultiline(d.serviceTitle || ''),
        '{{PLACE}}': xmlMultiline(d.place || ''),
        '{{CONDITIONS}}': xmlMultiline(conditionsText(d)),
        '{{EQUIPMENT}}': xmlMultiline(equipment),
        '{{SCOPE}}': xmlMultiline(scope),
        '{{TOTAL}}': xmlEsc(totalLine(d)),
        '{{VOLUME}}': xmlMultiline(d.volume || ''),
      };
      for (const [tok, val] of Object.entries(repl)) xml = xml.split(tok).join(val);
      zip.file('word/document.xml', xml);
      resolve(zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildServiceKpDocx };

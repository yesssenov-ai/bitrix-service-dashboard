// Генерация сервисного КП: берём ОРИГИНАЛЬНЫЙ шаблон (kp-service-template/template.docx,
// сделан из реального КП — сохранены логотип, шрифты, таблицы, оформление) и
// подставляем значения в плейсхолдеры через PizZip (как в модуле МЛК).
const fs = require('fs');
const path = require('path');
const PizZip = require('pizzip');

const TEMPLATE = path.join(__dirname, 'kp-service-template', 'template.docx');

const money = n => (Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
// Экранируем и превращаем переводы строк в <w:br/> внутри одного run.
function xmlMultiline(s) {
  return xmlEsc(s).split('\n').join('</w:t><w:br/><w:t xml:space="preserve">');
}

function buildDesc(d) {
  const lines = [];
  const eq = Array.isArray(d.equipment) ? d.equipment.filter(Boolean) : [];
  if (eq.length) {
    lines.push('Список оборудования:');
    eq.forEach(e => lines.push('• ' + e));
  }
  const scope = Array.isArray(d.scope) ? d.scope.filter(Boolean) : [];
  if (scope.length) {
    if (lines.length) lines.push('');
    lines.push('Перечень работ:');
    scope.forEach(s => lines.push('• ' + s));
  }
  return lines.join('\n');
}

function respLine(r) {
  r = r || {};
  const parts = [];
  if (r.name) parts.push(r.name);
  if (r.phone) parts.push(r.phone);
  let s = 'Ответственный: ' + parts.join(' ');
  if (r.email) s += ', e-mail: ' + r.email;
  return s;
}

async function buildServiceKpDocx(d) {
  const zip = new PizZip(fs.readFileSync(TEMPLATE));
  let xml = zip.file('word/document.xml').asText();
  const repl = {
    '{{DATE}}': xmlEsc(d.date || ''),
    '{{RESP}}': xmlEsc(respLine(d.responsible)),
    '{{TOTAL}}': xmlEsc(money(d.total)),
    '{{CLIENT}}': xmlEsc(d.client || ''),
    '{{TITLE}}': xmlMultiline(d.serviceTitle || 'Проведение технического обслуживания лабораторного оборудования'),
    '{{DESC}}': xmlMultiline(buildDesc(d)),
    '{{PLACE}}': xmlMultiline(d.place || ''),
    '{{CONDITIONS}}': xmlMultiline(d.conditions || ''),
    '{{VOLUME}}': xmlMultiline(d.volume || ''),
  };
  for (const [tok, val] of Object.entries(repl)) {
    xml = xml.split(tok).join(val);   // заменяем все вхождения (RESP встречается дважды)
  }
  zip.file('word/document.xml', xml);
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildServiceKpDocx };

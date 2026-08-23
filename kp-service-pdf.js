// Генерация сервисного КП в виде дизайнерского PDF (по эталону) через pdfmake.
// Обложка (логотип, крупный заголовок, дата, «Подготовлено для», футер-адрес),
// страница услуг (интро, список оборудования, перечень услуг, место, условия),
// финальная страница (объём/включения, ИТОГО, подпись).
const path = require('path');
const fs = require('fs');
const PdfPrinter = require('pdfmake/src/printer');

const FONT_DIR = path.join(__dirname, 'public', 'assets', 'fonts');
function pickFont(reg, bold) {
  const r = path.join(FONT_DIR, reg), b = path.join(FONT_DIR, bold);
  return fs.existsSync(r) && fs.existsSync(b) ? { normal: r, bold: b, italics: r, bolditalics: b } : null;
}
const FONT = pickFont('PTSans-Regular.ttf', 'PTSans-Bold.ttf') || pickFont('DejaVuSans.ttf', 'DejaVuSans-Bold.ttf');
const printer = new PdfPrinter({ Main: FONT });

const BRAND = '#C53B2F';
const DARK = '#1f2733';
const DIM = '#5c6884';
const money = n => (Number(n) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function logoDataUrl() {
  try {
    const p = path.join(__dirname, 'public', 'assets', 'company-full-logo.png');
    return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) { return null; }
}

const INTRO_DEFAULT = [
  'Компания Pro Lab Support занимается комплексным оснащением лабораторий, сервисным и методическим сопровождением пользователей аналитического оборудования.',
  'Инженеры компании имеют сертификаты от производителя оборудования и проходят регулярное обучение на заводе-изготовителе.',
  'Также является официальным дистрибьютором Agilent Technologies (США), Metrohm (Швейцария), Malvern Panalytical (Великобритания), Struers (Дания), Elga (Великобритания) и LNI Swissgas (Швейцария).',
];
const INCLUSIONS_DEFAULT = 'В стоимость услуги включены расходы по проезду и проживанию специалиста Поставщика. В стоимость услуги не включена стоимость запасных частей и расходных материалов.';
const PAYMENT_DEFAULT = '100% предоплата. Услуга оказывается только после получения полной оплаты.';

function buildServiceKpPdf(d) {
  const logo = logoDataUrl();
  const arr = v => Array.isArray(v) ? v.filter(Boolean) : (v ? String(v).split('\n').map(s => s.trim()).filter(Boolean) : []);
  const equipment = arr(d.equipment);
  const scope = arr(d.scope);
  const intro = arr(d.intro).length ? arr(d.intro) : INTRO_DEFAULT;
  const vatLabel = (d.vatMode === 'без') ? 'без учёта НДС' : 'с учётом НДС';
  const subtitle = d.serviceTitle || 'Техническое обслуживание аналитического оборудования на предприятии.';

  const content = [];
  // ── Обложка ──
  if (logo) content.push({ image: logo, width: 190, margin: [0, 10, 0, 30] });
  content.push({ text: 'КОММЕРЧЕСКОЕ', color: BRAND, bold: true, fontSize: 34, lineHeight: 1.02 });
  content.push({ text: 'ПРЕДЛОЖЕНИЕ', color: BRAND, bold: true, fontSize: 34, margin: [0, 0, 0, 18] });
  content.push({ text: subtitle, color: DARK, fontSize: 15, margin: [0, 0, 0, 26] });
  content.push({ text: 'Дата: ' + (d.date || ''), color: DIM, fontSize: 12, margin: [0, 0, 0, 30] });
  content.push({
    table: { widths: ['*'], body: [[{
      stack: [
        { text: 'Подготовлено для:', color: DIM, fontSize: 11, margin: [0, 0, 0, 6] },
        { text: d.client || '', color: DARK, bold: true, fontSize: 18 },
      ], margin: [14, 12, 14, 12],
    }]] },
    layout: { hLineWidth: () => 0, vLineWidth: (i) => i === 0 ? 3 : 0, vLineColor: () => BRAND, fillColor: () => '#f6f2f1' },
    margin: [0, 0, 0, 0],
  });

  // ── Страница услуг ──
  const page2 = [];
  intro.forEach(p => page2.push({ text: p, margin: [0, 0, 0, 8], fontSize: 11, color: DARK }));
  page2.push({ text: 'Сервис и методическая поддержка', bold: true, color: BRAND, fontSize: 14, margin: [0, 10, 0, 8] });
  page2.push({ text: 'Техническое обслуживание оборудования:', bold: true, margin: [0, 0, 0, 8] });
  if (equipment.length) {
    page2.push({ text: 'Список оборудования:', bold: true, margin: [0, 2, 0, 4] });
    page2.push({ ol: equipment, margin: [6, 0, 0, 10] });
  }
  if (scope.length) {
    page2.push({ text: 'Перечень услуг:', bold: true, margin: [0, 2, 0, 4] });
    page2.push({ ol: scope, margin: [6, 0, 0, 10] });
  }
  page2.push({ text: 'Место проведения сервисных услуг:', bold: true, margin: [0, 4, 0, 2] });
  page2.push({ text: d.place || '', margin: [0, 0, 0, 10] });
  page2.push({ text: 'Условия оказания сервисных услуг:', bold: true, margin: [0, 4, 0, 2] });
  page2.push({ text: d.conditions || '', margin: [0, 0, 0, 6] });
  if (d.term) page2.push({ text: 'Срок оказания услуги: ' + d.term, margin: [0, 4, 0, 6] });
  page2[0].pageBreak = 'before';
  content.push(...page2);

  // ── Финальная страница ──
  const page3 = [];
  page3.push({ text: subtitle, bold: true, color: BRAND, fontSize: 13, margin: [0, 0, 0, 8] });
  page3.push({ text: 'Условия оплаты:', bold: true, margin: [0, 0, 0, 2] });
  page3.push({ text: d.payment || PAYMENT_DEFAULT, margin: [0, 0, 0, 12], color: DARK });
  page3.push({ text: 'Состав и объём оказываемых услуг:', bold: true, margin: [0, 0, 0, 2] });
  if (d.volume) page3.push({ text: d.volume, margin: [0, 0, 0, 6] });
  page3.push({ text: d.inclusions || INCLUSIONS_DEFAULT, margin: [0, 0, 0, 18], color: DARK });
  page3.push({ text: 'Общая стоимость:', bold: true, fontSize: 13, margin: [0, 0, 0, 6] });
  page3.push({
    table: { widths: ['*'], body: [[{ text: `Итого ${vatLabel}: ${money(d.total)} ${d.currency || 'тенге'}.`, bold: true, fontSize: 15, color: '#fff', margin: [12, 10, 12, 10] }]] },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => BRAND }, margin: [0, 0, 0, 40],
  });
  const r = d.responsible || {};
  page3.push({ columns: [
    { text: ['Директор\n', { text: 'ТОО «ProLabSupport»', color: DIM }] },
    { text: d.director || 'Абылкасимов Р.С.', bold: true, alignment: 'right' },
  ], margin: [0, 0, 0, 16] });
  if (r.name) page3.push({ text: `Ответственный: ${r.name}${r.phone ? ', ' + r.phone : ''}${r.email ? ', e-mail: ' + r.email : ''}`, color: DIM, fontSize: 10 });
  page3[0].pageBreak = 'before';
  content.push(...page3);

  const footerAddr = 'Республика Казахстан, г. Астана, пр. Мәңгілік Ел, 55/22, Деловой Центр «EXPO»   ·   www.prolabsupport.kz   ·   service@prolabsupport.kz   ·   +7 705 659 90 72';
  const dd = {
    content,
    defaultStyle: { font: 'Main', fontSize: 11, color: DARK, lineHeight: 1.3 },
    pageMargins: [48, 48, 48, 60],
    footer: (cur) => (cur === 1 ? { text: footerAddr, alignment: 'center', color: DIM, fontSize: 8.5, margin: [40, 10, 40, 0] } : { text: 'ProLabSupport', alignment: 'center', color: '#c9d0dc', fontSize: 8, margin: [0, 10, 0, 0] }),
  };
  return new Promise((resolve, reject) => {
    try {
      const doc = printer.createPdfKitDocument(dd);
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildServiceKpPdf, INTRO_DEFAULT, INCLUSIONS_DEFAULT, PAYMENT_DEFAULT };

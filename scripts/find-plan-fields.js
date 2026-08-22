// Разведчик полей для модуля «План продаж».
// Выводит ТОЛЬКО поля-даты и поля-галочки (boolean) сделки с их кодами и
// названиями — среди них будут «Планируемый срок покупки» (дата) и «Наиболее
// вероятная сделка» (галочка). Плюс отдельно подсвечивает вероятных кандидатов.
//
// Запуск (нужен BITRIX_WEBHOOK в env, как у всего приложения):
//   node find-plan-fields.js
// Скопируй вывод в чат — я впишу точные коды в модуль.

const { b24 } = require('./bitrix');

const HINTS = [
  { col: '▶ Планируемый срок покупки (ДАТА)', re: /планир|срок.*покуп|покуп.*срок|ожид.*покуп|дата.*покуп|план.*дата/i },
  { col: '▶ Наиболее вероятная сделка (ГАЛОЧКА)', re: /вероятн|наиболее|горяч|красн|likely|hot/i },
];

function typeOf(f) { return `${f.type}${f.isMultiple ? '[]' : ''}`; }
function labelOf(f) { return f.formLabel || f.title || f.listLabel || ''; }

(async () => {
  const { result } = await b24('crm.deal.fields', {});
  const entries = Object.entries(result || {});

  const dates = entries.filter(([, f]) => /date/i.test(f.type));
  const bools = entries.filter(([, f]) => /boolean/i.test(f.type));

  console.log('='.repeat(90));
  console.log('ПОЛЯ-ДАТЫ сделки (код | тип | название)');
  console.log('='.repeat(90));
  dates.sort((a, b) => labelOf(a[1]).localeCompare(labelOf(b[1])))
    .forEach(([code, f]) => console.log(`${code.padEnd(30)} ${typeOf(f).padEnd(12)} ${labelOf(f)}`));

  console.log('\n' + '='.repeat(90));
  console.log('ПОЛЯ-ГАЛОЧКИ сделки (boolean) (код | тип | название)');
  console.log('='.repeat(90));
  bools.sort((a, b) => labelOf(a[1]).localeCompare(labelOf(b[1])))
    .forEach(([code, f]) => console.log(`${code.padEnd(30)} ${typeOf(f).padEnd(12)} ${labelOf(f)}`));

  console.log('\n' + '='.repeat(90));
  console.log('ВЕРОЯТНЫЕ КАНДИДАТЫ');
  console.log('='.repeat(90));
  for (const hint of HINTS) {
    console.log(`\n${hint.col}`);
    const m = entries.filter(([code, f]) => hint.re.test(labelOf(f)) || hint.re.test(code));
    if (!m.length) { console.log('    (не найдено — посмотри в списках выше)'); continue; }
    m.forEach(([code, f]) => console.log(`    ${code.padEnd(28)} ${typeOf(f).padEnd(12)} ${labelOf(f)}`));
  }
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });

// Сам находит ДЕНЬ МИГРАЦИИ (день октября 2025 с аномальным всплеском созданных
// сделок) и по нему — поле «ID сделки в старом портале» (заполнено у мигрированных,
// пусто у новых, значение — целое число = старый ID). Точную дату знать не нужно.
//   node find-oldid-field.js "ВЕБХУК" > oldid.txt 2>&1
// Если миграция была в другом месяце — передай его 2-м аргументом: ... "ВЕБХУК" 2025-11

const BASE = (process.argv[2] || process.env.BITRIX_WEBHOOK || '').trim();
const MONTH = (process.argv[3] || '2025-10').trim(); // месяц миграции (YYYY-MM)
if (!BASE || !/^https?:\/\//i.test(BASE)) {
  console.error('❌ Укажи вебхук: node find-oldid-field.js "https://портал.bitrix24.kz/rest/ID/КОД/" [YYYY-MM]');
  process.exit(1);
}
function toForm(obj) {
  const p = new URLSearchParams();
  const walk = (prefix, val) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) val.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    else if (typeof val === 'object') Object.entries(val).forEach(([k, v]) => walk(`${prefix}[${k}]`, v));
    else p.append(prefix, val);
  };
  Object.entries(obj).forEach(([k, v]) => walk(k, v));
  return p.toString();
}
async function call(method, params) {
  const url = BASE.replace(/\/?$/, '/') + method + '.json';
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: toForm(params || {}) });
  const d = await res.json().catch(() => ({}));
  if (d.error) throw new Error(method + ': ' + d.error + ' ' + (d.error_description || ''));
  return d;
}
const isIntStr = v => typeof v === 'string' ? /^\d{1,8}$/.test(v) : (typeof v === 'number' && Number.isInteger(v));
const nonEmpty = v => !(v === '' || v === false || v == null || v === '0' || (Array.isArray(v) && !v.length));

// Границы месяца.
function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number);
  const start = `${ym}-01T00:00:00+05:00`;
  const nm = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  const end = `${nm}-01T00:00:00+05:00`;
  return { start, end };
}

async function main() {
  // 1) Гистограмма создания по дням месяца миграции — ищем день-всплеск.
  const { start, end } = monthBounds(MONTH);
  console.log(`Считаю создания по дням за ${MONTH}…`);
  const perDay = {}; const idByDay = {};
  let cnt = 0, start0 = 0, pages = 0;
  while (pages < 120) { // предохранитель (~6000 сделок)
    const { result, next } = await call('crm.deal.list', {
      filter: { '>=DATE_CREATE': start, '<DATE_CREATE': end },
      select: ['ID', 'DATE_CREATE'], order: { ID: 'DESC' }, start: start0,
    });
    for (const d of (result || [])) {
      const day = String(d.DATE_CREATE || '').slice(0, 10);
      perDay[day] = (perDay[day] || 0) + 1; cnt++;
      (idByDay[day] = idByDay[day] || []).push(d.ID);
    }
    pages++;
    if (next === undefined || next === null) break;
    start0 = next;
  }
  const days = Object.entries(perDay).sort((a, b) => b[1] - a[1]);
  console.log(`Всего создано за ${MONTH} (образец): ${cnt}\n`);
  console.log('=== Топ дней по числу созданных сделок ===');
  days.slice(0, 8).forEach(([d, n]) => console.log(`   ${d}: ${n}`));
  const migDay = days.length ? days[0][0] : null;
  if (!migDay) { console.log('\n⚠️ Сделок за месяц не нашлось — укажи другой месяц 2-м аргументом (напр. 2025-11).'); return; }
  console.log(`\n➡️ День миграции (всплеск): ${migDay}\n`);

  // 2) Образец мигрированных (этот день) с UF_* и новых (2026-06+) с UF_*.
  const withUf = async (filter, limit) => {
    let items = [], s = 0;
    while (items.length < limit) {
      const { result, next } = await call('crm.deal.list', { filter, select: ['ID', 'DATE_CREATE', 'UF_*'], order: { ID: 'DESC' }, start: s });
      items = items.concat(result || []);
      if (next === undefined || next === null) break;
      s = next;
    }
    return items.slice(0, limit);
  };
  const migrated = await withUf({ '>=DATE_CREATE': migDay + 'T00:00:00+05:00', '<=DATE_CREATE': migDay + 'T23:59:59+05:00' }, 60);
  const fresh = await withUf({ '>=DATE_CREATE': '2026-06-01T00:00:00+05:00' }, 60);
  console.log(`Образец мигрированных: ${migrated.length}, новых: ${fresh.length}\n`);

  // 3) Статистика по UF-полям: заполнено у мигрированных целым числом vs у новых.
  const stat = {};
  const scan = (rows, who) => {
    for (const d of rows) {
      const selfId = String(d.ID);
      for (const [k, v] of Object.entries(d)) {
        if (!k.startsWith('UF_')) continue;
        const s = stat[k] = stat[k] || { migInt: 0, freshFilled: 0, distinct: new Set(), samples: [] };
        if (!nonEmpty(v)) continue;
        if (who === 'mig') {
          const val = Array.isArray(v) ? v[0] : v;
          if (isIntStr(val) && String(val) !== selfId) { s.migInt++; s.distinct.add(String(val)); if (s.samples.length < 6) s.samples.push(`${selfId}→${val}`); }
        } else s.freshFilled++;
      }
    }
  };
  scan(migrated, 'mig'); scan(fresh, 'fresh');

  const cand = Object.entries(stat)
    .map(([name, s]) => ({ name, ...s, distinctN: s.distinct.size, score: s.migInt - s.freshFilled * 2 + Math.min(s.distinct.size, 40) * 0.5 }))
    .filter(c => c.migInt >= Math.max(3, migrated.length * 0.3))
    .sort((a, b) => b.score - a.score).slice(0, 12);

  console.log('=== КАНДИДАТЫ НА «ID СТАРОГО ПОРТАЛА» (лучшие сверху) ===\n');
  for (const c of cand) {
    console.log(`${c.name}  целых-ID у мигр.: ${c.migInt}/${migrated.length}, у новых заполнено: ${c.freshFilled}/${fresh.length}, уник.значений: ${c.distinctN}`);
    console.log(`      примеры (новыйID→старыйID?): ${c.samples.join(', ')}`);
  }
  if (!cand.length) console.log('(не нашлось — пришли скрин карточки мигрированной сделки с полем «ID сделки в старом портале»)');
  console.log('\n=== ГОТОВО. Пришли oldid.txt. ===');
}
main().then(() => process.exit(0)).catch(e => { console.error('Фатальная ошибка:', e.message); process.exit(1); });

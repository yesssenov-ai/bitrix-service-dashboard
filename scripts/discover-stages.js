#!/usr/bin/env node
// Пробник: выгружает СТАДИИ всех 4 воронок продаж (STATUS_ID, название, сортировка)
// и считает, сколько сделок сейчас в каждой стадии. НИЧЕГО НЕ МЕНЯЕТ.
// Нужен, чтобы точно замапить P10/P30/P60/P80/Контракт/Завершённые под каждую
// воронку для нового модуля Статистики.
//   node scripts/discover-stages.js  ["https://ВАШ_ПОРТАЛ/rest/USER/TOKEN/"]
try { require('dotenv').config(); } catch (e) {}
if (!process.env.BITRIX_WEBHOOK && process.argv[2]) process.env.BITRIX_WEBHOOK = process.argv[2].trim();
if (!process.env.BITRIX_WEBHOOK) { console.error('❌ BITRIX_WEBHOOK не найден'); process.exit(1); }
const { b24 } = require('../bitrix');

const CATS = ['0', '1', '2', '3'];
const CAT_NAME = { '0': 'Продажа инструментов', '1': 'Расходные материалы', '2': 'Тренинг-центр', '3': 'Сервис' };
const P = (...a) => console.log(...a);
const HR = t => P('\n' + '━'.repeat(74) + '\n' + t + '\n' + '━'.repeat(74));

async function stagesFor(catId) {
  // crm.dealcategory.stage.list возвращает стадии конкретной воронки
  try {
    const { result } = await b24('crm.dealcategory.stage.list', { id: catId });
    return result || [];
  } catch (e) { return []; }
}

async function countByStage(catId) {
  const counts = {}; let start = 0, guard = 0;
  while (guard++ < 200) {
    const { result, next } = await b24('crm.deal.list', { filter: { CATEGORY_ID: catId }, select: ['STAGE_ID'], start });
    (result || []).forEach(d => { counts[d.STAGE_ID] = (counts[d.STAGE_ID] || 0) + 1; });
    if (next === undefined || next === null) break;
    start = next;
  }
  return counts;
}

async function main() {
  for (const cat of CATS) {
    HR(`ВОРОНКА ${cat} · ${CAT_NAME[cat]}`);
    const stages = await stagesFor(cat);
    const counts = await countByStage(cat);
    if (!stages.length) { P('  (стадии не получены — возможно, нет доступа к crm.dealcategory.stage.list)'); }
    stages.forEach(s => {
      const n = counts[s.STATUS_ID] || 0;
      P(`  SORT ${String(s.SORT).padStart(4)} · STATUS_ID="${s.STATUS_ID}"  →  «${s.NAME}»   [сделок сейчас: ${n}]`);
    });
    // стадии, встретившиеся в сделках, но не в списке (на всякий случай)
    const known = new Set(stages.map(s => s.STATUS_ID));
    Object.keys(counts).filter(k => !known.has(k)).forEach(k => P(`  (не в списке) STATUS_ID="${k}"  [сделок: ${counts[k]}]`));
  }
  P('\n✅ Готово. Пришлите весь вывод — замаплю P10/P30/P60/P80/Контракт/Завершённые.');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

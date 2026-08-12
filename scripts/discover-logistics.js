#!/usr/bin/env node
// Discovery-probe для модуля «Логистика». НИЧЕГО НЕ МЕНЯЕТ — только читает.
// Задача: показать, из каких процессов/стадий/полей собрать сквозной маршрут
// заказа (заказ размещён → оплата → отгрузка → в пути → таможня → склад →
// доставка → установка → документы), и где лежат дата отгрузки, ETA, трек-номер,
// перевозчик, способ доставки, тип товара/лицензия.
//
// Запуск из корня репозитория (там, где .env с BITRIX_WEBHOOK):
//   node scripts/discover-logistics.js
// Если .env не подхватился — можно передать вебхук аргументом:
//   node scripts/discover-logistics.js "https://ВАШ_ПОРТАЛ.bitrix24.kz/rest/USER/TOKEN/"
// Затем пришлите весь вывод.

// ── Загрузка вебхука ДО require('../bitrix') (он читает env при загрузке) ──
try { require('dotenv').config(); } catch (e) { /* dotenv может отсутствовать — не критично */ }
if (!process.env.BITRIX_WEBHOOK && process.argv[2]) process.env.BITRIX_WEBHOOK = process.argv[2].trim();
if (!process.env.BITRIX_WEBHOOK) {
  console.error('❌ BITRIX_WEBHOOK не найден. Варианты:\n' +
    '   1) добавьте в .env строку  BITRIX_WEBHOOK=https://…/rest/USER/TOKEN/\n' +
    '   2) передайте аргументом:   node scripts/discover-logistics.js "https://…/rest/USER/TOKEN/"');
  process.exit(1);
}
const { b24 } = require('../bitrix');

const KEYWORDS = /закуп|логист|достав|постав|отгруз|транспорт|перевоз|карго|cargo|track|трек|тамож|customs|склад|достав|invoice|eta|прибыт|срок|дата|лиценз|разреш|груз|товар|способ|метод|номер|контейнер|awb|bl|коносам|двойн/i;

const P = (...a) => console.log(...a);
const HR = t => P('\n' + '─'.repeat(70) + '\n' + t + '\n' + '─'.repeat(70));

async function main() {
  // 1) Все смарт-процессы (типы) — ищем «Закупки»/«Логистику»/«Доставку».
  HR('1. СМАРТ-ПРОЦЕССЫ (crm.type.list)');
  let types = [];
  try {
    const { result } = await b24('crm.type.list', {});
    types = (result && result.types) || [];
    types.forEach(t => P(`  entityTypeId=${t.entityTypeId}  «${t.title}»  (id=${t.id})`));
  } catch (e) { P('  crm.type.list error:', e.message); }

  // Кандидаты для логистики: по названию + заведомо «Закупки» (1066).
  const candidates = new Set([1066]);
  types.forEach(t => { if (KEYWORDS.test(t.title || '')) candidates.add(Number(t.entityTypeId)); });

  for (const etid of candidates) {
    const t = types.find(x => Number(x.entityTypeId) === etid);
    HR(`2. ПРОЦЕСС entityTypeId=${etid} ${t ? '«' + t.title + '»' : '(предположительно Закупки)'}`);

    // 2a) Воронки (категории)
    let cats = [];
    try {
      const { result } = await b24('crm.category.list', { entityTypeId: etid });
      cats = (result && result.categories) || [];
      P('  Воронки:');
      cats.forEach(c => P(`    categoryId=${c.id}  «${c.name}»`));
    } catch (e) { P('  crm.category.list error:', e.message); }

    // 2b) Стадии каждой воронки
    for (const c of cats.length ? cats : [{ id: 0, name: 'default' }]) {
      const entityId = `DYNAMIC_${etid}_STAGE_${c.id}`;
      try {
        const { result } = await b24('crm.status.list', {
          filter: { ENTITY_ID: entityId },
          select: ['STATUS_ID', 'NAME', 'SORT', 'SEMANTICS'],
        });
        P(`\n  Стадии воронки «${c.name}» (${entityId}):`);
        (result || []).sort((a, b) => (+a.SORT || 0) - (+b.SORT || 0))
          .forEach(s => P(`    [${String(s.SORT).padStart(3)}] ${s.STATUS_ID}  «${s.NAME}»  sem=${s.SEMANTICS || '-'}`));
      } catch (e) { P(`  stages(${entityId}) error:`, e.message); }
    }

    // 2c) Поля процесса — печатаем все, помечаем ★ подозрительные (дата/трек/…).
    try {
      const { result } = await b24('crm.item.fields', { entityTypeId: etid });
      const fields = (result && result.fields) || {};
      P(`\n  Поля (${Object.keys(fields).length}). ★ = похоже на дату/трек/логистику:`);
      Object.entries(fields).forEach(([code, f]) => {
        const label = f.title || '';
        const mark = (KEYWORDS.test(label) || /date|time/i.test(f.type || '')) ? '★' : ' ';
        P(`   ${mark} ${code}  [${f.type}]  «${label}»`);
      });
    } catch (e) { P('  crm.item.fields error:', e.message); }

    // 2d) 3 свежие записи — печатаем непустые поля (реальные значения дат/трека).
    try {
      const { result } = await b24('crm.item.list', {
        entityTypeId: etid, order: { id: 'desc' }, start: 0,
      });
      const items = (result && result.items) || [];
      P(`\n  Примеры записей (${Math.min(3, items.length)} из ${items.length} на странице):`);
      items.slice(0, 3).forEach(it => {
        P(`\n    ── item #${it.id} (stageId=${it.stageId}, title=${it.title || ''}) ──`);
        Object.entries(it).forEach(([k, v]) => {
          if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
          const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
          P(`      ${k} = ${val.length > 120 ? val.slice(0, 120) + '…' : val}`);
        });
      });
    } catch (e) { P('  crm.item.list error:', e.message); }
  }

  // 3) Стадии сделок (доменная часть пути: подготовка к отгрузке → установка → документы).
  HR('3. СТАДИИ СДЕЛОК (доменная доставка/установка)');
  for (const [cat, ent] of Object.entries({ 0: 'DEAL_STAGE', 1: 'DEAL_STAGE_1', 2: 'DEAL_STAGE_2', 3: 'DEAL_STAGE_3' })) {
    try {
      const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: ent }, select: ['STATUS_ID', 'NAME', 'SORT', 'SEMANTICS'] });
      P(`\n  Воронка ${cat} (${ent}):`);
      (result || []).sort((a, b) => (+a.SORT || 0) - (+b.SORT || 0)).forEach(s => P(`    [${String(s.SORT).padStart(3)}] ${s.STATUS_ID}  «${s.NAME}»  sem=${s.SEMANTICS || '-'}`));
    } catch (e) { P(`  ${ent} error:`, e.message); }
  }

  P('\n✅ Готово. Пришлите весь вывод — соберу карту вех и список нужных полей.');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

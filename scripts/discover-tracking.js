#!/usr/bin/env node
// Probe: где реально заполнены трек-номера и перевозчики. НИЧЕГО НЕ МЕНЯЕТ.
// Показывает покрытие (сколько закупок/логистик имеют трек), примеры номеров и
// перевозчиков — чтобы понять, можно ли подключить живой трекинг и по какому
// агрегатору. Запуск из корня репозитория:
//   node scripts/discover-tracking.js  ["https://ВАШ_ПОРТАЛ.bitrix24.kz/rest/USER/TOKEN/"]
try { require('dotenv').config(); } catch (e) {}
if (!process.env.BITRIX_WEBHOOK && process.argv[2]) process.env.BITRIX_WEBHOOK = process.argv[2].trim();
if (!process.env.BITRIX_WEBHOOK) { console.error('❌ BITRIX_WEBHOOK не найден'); process.exit(1); }
const { b24 } = require('../bitrix');

const P = (...a) => console.log(...a);
const HR = t => P('\n' + '─'.repeat(70) + '\n' + t + '\n' + '─'.repeat(70));
const val = v => (v && typeof v === 'object') ? JSON.stringify(v) : v;
const nonEmpty = v => v != null && v !== '' && !(Array.isArray(v) && !v.length);

async function itemList(entityTypeId, categoryId, select) {
  let items = [], start = 0;
  while (true) {
    const { result } = await b24('crm.item.list', { entityTypeId, filter: { categoryId }, select, start });
    const batch = (result && result.items) || [];
    items = items.concat(batch); start += batch.length;
    if (!batch.length || batch.length < 50) break;
    if (start > 5000) break;
  }
  return items;
}

async function main() {
  // Закупки: трек-номер + трек-url
  const T1066 = 'ufCrm10_1732858436450', TU1066 = 'ufCrm10_1732858524962', PO1066 = 'ufCrm10_1763536157575';
  const purch = await itemList(1066, 13, ['id', 'title', 'stageId', T1066, TU1066, PO1066]);
  const pFilled = purch.filter(p => nonEmpty(p[T1066]) || nonEmpty(p[TU1066]));
  HR(`ЗАКУПКИ (1066): трек заполнен у ${pFilled.length} из ${purch.length} (${Math.round(pFilled.length / (purch.length || 1) * 100)}%)`);
  pFilled.slice(0, 25).forEach(p => P(`  #${p.id} PO=${val(p[PO1066]) || '—'} стадия=${p.stageId}\n     трек="${val(p[T1066]) || ''}"  url="${val(p[TU1066]) || ''}"\n     «${(p.title || '').slice(0, 70)}»`));

  // Логистика: трек-номер + перевозчик
  const T1070 = 'ufCrm11_1732865717409', TU1070 = 'ufCrm11_1732865771593', CAR = 'ufCrm11_1732866072';
  const logi = await itemList(1070, 14, ['id', 'title', 'stageId', 'parentId1066', T1070, TU1070, CAR]);
  const lFilled = logi.filter(l => nonEmpty(l[T1070]) || nonEmpty(l[TU1070]));
  const lCarrier = logi.filter(l => nonEmpty(l[CAR]));
  HR(`ЛОГИСТИКА (1070): трек у ${lFilled.length} из ${logi.length} (${Math.round(lFilled.length / (logi.length || 1) * 100)}%), перевозчик указан у ${lCarrier.length}`);
  lFilled.slice(0, 25).forEach(l => P(`  #${l.id} закупка=${val(l.parentId1066) || '—'} стадия=${l.stageId}\n     трек="${val(l[T1070]) || ''}"  url="${val(l[TU1070]) || ''}"  перевозчик(id)="${val(l[CAR]) || '—'}"\n     «${(l.title || '').slice(0, 70)}»`));

  // Перевозчик — это ссылка на сущность CRM. Покажем, на что ссылается (пример).
  const carrierIds = [...new Set(logi.map(l => l[CAR]).filter(nonEmpty).map(v => Array.isArray(v) ? v[0] : v))];
  HR(`ПЕРЕВОЗЧИКИ: уникальных значений ссылки — ${carrierIds.length}`);
  P('  Сырые значения (первые 10): ' + carrierIds.slice(0, 10).map(val).join(', '));
  P('  (это ссылки на сущность CRM — по ним можно достать название перевозчика; покажу как, если нужно)');

  P('\n✅ Готово. Пришлите вывод — оценим покрытие и путь к живому трекингу.');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });

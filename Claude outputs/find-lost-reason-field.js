// Названий полей этот портал через API не отдаёт. Поэтому опознаём поле «Причина
// отказа» по его СПРАВОЧНИКУ: расшифровываем справочники всех полей-справочников
// (iblock_element), заполненных на проигранных сделках, и печатаем их варианты —
// у поля «Причина отказа» варианты будут причинами (несоответствие/дороже/бюджет…).
// Вебхук — аргументом:
//   node find-lost-reason-field.js "ВЕБХУК" > reason.txt 2>&1
// затем пришли reason.txt.

const BASE = (process.argv[2] || process.env.BITRIX_WEBHOOK || '').trim();
if (!BASE || !/^https?:\/\//i.test(BASE)) {
  console.error('❌ Укажи вебхук аргументом: node find-lost-reason-field.js "https://портал.bitrix24.kz/rest/ID/КОД/"');
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
  return d.result;
}

// Достаём элементы справочника (iblock/lists) → {ID: NAME}. Пробуем разные типы.
async function loadIblock(iblockId, typeHint) {
  const map = {};
  const types = [typeHint, 'lists', 'bitrix_processes'].filter(Boolean);
  for (const type of [...new Set(types)]) {
    try {
      let start = 0;
      for (let i = 0; i < 20; i++) {
        const r = await call('lists.element.get', { IBLOCK_TYPE_ID: type, IBLOCK_ID: iblockId, ELEMENT_ORDER: { ID: 'ASC' }, start });
        const arr = Array.isArray(r) ? r : (r && r.items) || [];
        arr.forEach(e => { map[String(e.ID)] = e.NAME; });
        if (arr.length < 50) break;
        start += 50;
      }
      if (Object.keys(map).length) return { map, type };
    } catch (e) { /* следующий тип */ }
  }
  return { map, type: null };
}

async function main() {
  const ufs = (await call('crm.deal.userfield.list', { order: { SORT: 'ASC' }, filter: {} })) || [];
  const iblockFields = ufs.filter(f => f.USER_TYPE_ID === 'iblock_element');
  console.log(`Полей-справочников (iblock_element): ${iblockFields.length}\n`);

  // Тянем проигранные сделки со ВСЕМИ полями-справочниками — узнаём, какие заполнены.
  const names = iblockFields.map(f => f.FIELD_NAME);
  const deals = (await call('crm.deal.list', {
    filter: { STAGE_SEMANTIC_ID: 'F' },
    select: ['ID', 'TITLE', 'STAGE_ID', ...names],
    order: { ID: 'DESC' }, start: 0,
  })) || [];
  const sample = deals.slice(0, 20);

  // Кандидаты = справочники, непустые хотя бы на одной проигранной сделке.
  const filled = {};
  for (const d of sample) for (const n of names) {
    const v = d[n];
    if (v !== '' && v !== false && v != null && !(Array.isArray(v) && !v.length)) (filled[n] = filled[n] || []).push(v);
  }
  const candNames = Object.keys(filled);
  console.log(`Заполнены на проигранных: ${candNames.length} справочников: ${candNames.join(', ')}\n`);

  console.log('=== СПРАВОЧНИКИ-КАНДИДАТЫ И ИХ ВАРИАНТЫ ===\n');
  const RXREASON = /несоответ|дорог|цен|бюджет|конкур|финансир|срок|поздно|техническ|требован|отказ|друг|информ|услов|поставщик|конкурс|тендер/i;
  const resolved = {}; // name -> {map,type}
  for (const n of candNames) {
    const f = iblockFields.find(x => x.FIELD_NAME === n);
    const s = f.SETTINGS || {};
    const { map, type } = await loadIblock(s.IBLOCK_ID, s.IBLOCK_TYPE_ID);
    resolved[n] = map;
    const opts = Object.values(map);
    const looksReason = opts.some(o => RXREASON.test(String(o)));
    console.log(`${n}  IBLOCK_ID=${s.IBLOCK_ID}  вариантов=${opts.length}  тип=${type || 'НЕ РАСШИФРОВАН'}${looksReason ? '   ⭐ ПОХОЖЕ НА ПРИЧИНЫ' : ''}`);
    if (opts.length && opts.length <= 40) opts.forEach((o, i) => console.log(`      ${Object.keys(map)[i]} = ${o}`));
    else if (opts.length) console.log(`      (${opts.length} вариантов — покажу полностью только у поля-причины ниже)`);
    console.log('');
  }

  // Поле-причина: у которого варианты выглядят как причины.
  const reasonName = candNames.find(n => Object.values(resolved[n] || {}).some(o => RXREASON.test(String(o))));
  console.log('=== ИТОГ ===');
  if (!reasonName) {
    console.log('Автоматически не опознал. Выше — все справочники-кандидаты с вариантами, найдём нужный глазами.');
  } else {
    console.log(`Поле «Причина отказа» = ${reasonName}\n`);
    console.log('Полный список причин:');
    Object.entries(resolved[reasonName]).forEach(([id, nm]) => console.log(`   ${id} = ${nm}`));
    console.log('\nЗначения на проигранных сделках:');
    for (const d of sample) {
      const v = d[reasonName];
      if (v === '' || v === false || v == null) continue;
      const human = Array.isArray(v) ? v.map(x => resolved[reasonName][String(x)] || `#${x}`).join(', ') : (resolved[reasonName][String(v)] || `#${v}`);
      console.log(`   #${d.ID}  ${d.STAGE_ID}  «${(d.TITLE || '').slice(0, 35)}»  → ${human}`);
    }
  }
  console.log('\n=== ГОТОВО. Пришли reason.txt. ===');
}
main().then(() => process.exit(0)).catch(e => { console.error('Фатальная ошибка:', e.message); process.exit(1); });

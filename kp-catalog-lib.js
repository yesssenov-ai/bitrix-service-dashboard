const XLSX = require('xlsx');

// Sheet name -> stable category slug + display name. Add new sheets here if
// the catalog grows; unmapped sheet names are skipped with a warning so a
// typo in a tab name doesn't silently import into the wrong bucket.
const SHEET_MAP = {
  'ПРИЕМКА':          { slug: 'priemka',          name: 'Приёмка' },
  'ПРОБОПОДГОТОВКА':  { slug: 'probopodgotovka',  name: 'Пробоподготовка' },
  'ПРОБИРНЫЙ АНАЛИЗ': { slug: 'probirny',         name: 'Пробирный анализ' },
  'АНАЛИТИКА':        { slug: 'analitika',        name: 'Аналитика' },
  'ПРЕКУРСОРНАЯ':     { slug: 'prekursornaya',     name: 'Прекурсорная' },
};

// Приведение имени листа к устойчивому виду: верхний регистр, Ё→Е, только буквы/цифры.
function sheetKey(s) {
  return String(s || '').toUpperCase().replace(/Ё/g, 'Е').replace(/[^А-ЯA-Z0-9]/g, '');
}
const SHEET_MAP_NORM = {};
for (const [k, v] of Object.entries(SHEET_MAP)) SHEET_MAP_NORM[sheetKey(k)] = v;

// Сопоставляет лист категории, даже если вкладку переименовали (напр.
// «ПОМ.ДЛЯ РЕАКТИВ» → Прекурсорная): сначала точное совпадение по
// нормализованному имени, затем по ключевым словам.
function resolveSheet(sheetName) {
  const k = sheetKey(sheetName);
  if (SHEET_MAP_NORM[k]) return SHEET_MAP_NORM[k];
  if (/ПРИЕМ/.test(k)) return SHEET_MAP['ПРИЕМКА'];
  if (/ПРОБОПОДГ|ПОДГОТОВ/.test(k)) return SHEET_MAP['ПРОБОПОДГОТОВКА'];
  if (/ПРОБИРН/.test(k)) return SHEET_MAP['ПРОБИРНЫЙ АНАЛИЗ'];
  if (/АНАЛИТИК/.test(k)) return SHEET_MAP['АНАЛИТИКА'];
  if (/ПРЕКУРСОР|РЕАКТИВ/.test(k)) return SHEET_MAP['ПРЕКУРСОРНАЯ']; // прекурсорная = помещение для реактивов
  return null;
}

function normalizeForKey(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Simple, dependency-free stable hash for generating a stable_key from
// category+name. Re-importing the same catalog produces the same keys, so
// price updates match up to the existing item instead of creating a
// duplicate — as long as the item's name doesn't change.
function stableHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// Parses the workbook buffer into { categories: [{slug,name}], items: [...] }.
// Row logic per sheet: column B present => real catalog item; column A
// present with B empty => section-header row (updates the running section
// label for subsequent items); everything else is skipped (spacer/summary
// rows like "СУММА").
function parseCatalogWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const categories = [];
  const items = [];
  const warnings = [];

  for (const sheetName of wb.SheetNames) {
    const mapping = resolveSheet(sheetName);
    if (!mapping) { warnings.push(`Лист "${sheetName}" не распознан и пропущен (нет в списке известных категорий)`); continue; }
    if (categories.some(c => c.slug === mapping.slug)) { warnings.push(`Лист "${sheetName}" пропущен: категория «${mapping.name}» уже заполнена другим листом`); continue; }
    categories.push(mapping);

    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

    // Detect optional Технические характеристики / Мощность columns from row 0 headers
    const header = rows[0] || [];
    let specsCol = -1, powerCol = -1;
    header.forEach((h, i) => {
      const hs = normalizeForKey(h);
      if (hs.includes('характеристик')) specsCol = i;
      if (hs.includes('мощност')) powerCol = i;
    });

    let currentSection = null;
    let sortOrder = 0;
    const seenKeys = {}; // dedupe counter for genuinely repeated (section+name) combos

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const colA = row[0], colB = row[1], colC = row[2], colD = row[3];
      // Футер-примечание в конце листа («Примечание.», инструкции) — не позиции.
      // Как только встретили маркер «Примечание…» в любой из первых колонок — весь
      // остаток листа игнорируем.
      const aTxt = colA != null ? String(colA).trim() : '';
      const bTxt = colB != null ? String(colB).trim() : '';
      if (/^примечани[ея]/i.test(aTxt) || /^примечани[ея]/i.test(bTxt)) break;

      const nameVal = colB !== null && colB !== undefined ? String(colB).trim() : '';

      if (!nameVal) {
        // Section header row (or a blank/summary row) — text only in col A
        if (colA !== null && colA !== undefined && String(colA).trim()) {
          const txt = String(colA).trim();
          if (!/^сумма$/i.test(txt)) currentSection = txt;
        }
        continue;
      }

      sortOrder++;
      const baseKeyInput = mapping.slug + '|' + normalizeForKey(currentSection) + '|' + normalizeForKey(nameVal);
      const dupCount = (seenKeys[baseKeyInput] = (seenKeys[baseKeyInput] || 0) + 1);
      const keyInput = dupCount > 1 ? `${baseKeyInput}|${dupCount}` : baseKeyInput;
      const stable_key = stableHash(keyInput);
      items.push({
        stable_key,
        category_slug: mapping.slug,
        section_name: currentSection,
        item_no: colA !== null && colA !== undefined ? String(colA).trim() : null,
        name: nameVal,
        unit_price: parsePrice(colD),
        is_included: false,
        specs: specsCol >= 0 && row[specsCol] ? String(row[specsCol]).trim() : null,
        power_kw: powerCol >= 0 && row[powerCol] ? String(row[powerCol]).trim() : null,
        sort_order: sortOrder,
      });
    }
  }

  return { categories, items, warnings };
}

module.exports = { parseCatalogWorkbook, stableHash, normalizeForKey, SHEET_MAP };

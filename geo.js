// Определение страны по справочнику «Город/Область/Страна» (IBLOCK 17).
// Логика (подтверждена на данных): для РК в поле стоит ОБЛАСТЬ/ГОРОД (Алматы, Астана…),
// для прочих стран — НАЗВАНИЕ СТРАНЫ (Азербайджан…). Значит: имя совпало со страной из
// словаря → эта страна; иначе (регион/город РК) → Казахстан.
const { b24 } = require('./bitrix');

const GEO_IBLOCK = Number(process.env.GEO_IBLOCK_ID || 17);
const GEO_IBLOCK_TYPE = process.env.GEO_IBLOCK_TYPE || 'lists';
const GEO_FIELD_COMPANY = process.env.GEO_FIELD_COMPANY || 'UF_CRM_1731861583';
const GEO_FIELD_DEAL = process.env.GEO_FIELD_DEAL || 'UF_CRM_1731862648';

// Название страны (рус.) → ISO2. Всё, что НЕ здесь, трактуем как Казахстан.
const COUNTRY = {
  'казахстан': 'KZ', 'узбекистан': 'UZ', 'кыргызстан': 'KG', 'киргизия': 'KG',
  'таджикистан': 'TJ', 'туркменистан': 'TM', 'туркмения': 'TM', 'азербайджан': 'AZ',
  'армения': 'AM', 'грузия': 'GE', 'россия': 'RU', 'российская федерация': 'RU',
  'беларусь': 'BY', 'белоруссия': 'BY', 'украина': 'UA', 'молдова': 'MD', 'молдавия': 'MD',
  'монголия': 'MN', 'китай': 'CN', 'кнр': 'CN', 'турция': 'TR', 'иран': 'IR',
  'афганистан': 'AF', 'индия': 'IN', 'пакистан': 'PK',
  'оаэ': 'AE', 'объединённые арабские эмираты': 'AE', 'саудовская аравия': 'SA',
  'германия': 'DE', 'франция': 'FR', 'сша': 'US', 'южная корея': 'KR', 'корея': 'KR', 'япония': 'JP',
};

let _dir = null, _dirAt = 0, _loading = null;
async function loadGeoDir() {
  if (_dir && Date.now() - _dirAt < 6 * 3600 * 1000) return _dir;
  if (_loading) return _loading;
  _loading = (async () => {
    const map = {};
    try {
      for (let start = 0; start < 5000; start += 50) {
        const r = await b24('lists.element.get', { IBLOCK_TYPE_ID: GEO_IBLOCK_TYPE, IBLOCK_ID: GEO_IBLOCK, start });
        const arr = (r && r.result) || [];
        for (const e of arr) map[String(e.ID)] = e.NAME;
        if (arr.length < 50) break;
      }
    } catch (e) { console.error('geo loadGeoDir:', e.message); }
    _dir = map; _dirAt = Date.now(); _loading = null;
    return map;
  })();
  return _loading;
}

const _norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/ё/g, 'е');
function countryFromName(name) {
  const n = _norm(name);
  if (!n) return '';
  for (const k in COUNTRY) if (n === k || n.indexOf(k) >= 0) return COUNTRY[k];
  return 'KZ'; // область/город РК
}

// geoId — значение поля справочника (может быть массивом/строкой). bin — наличие БИН ⇒ РК.
async function resolveCountry(geoId, bin) {
  const id = Array.isArray(geoId) ? geoId[0] : geoId;
  if (id != null && String(id).trim() !== '') {
    const dir = await loadGeoDir();
    const nm = dir[String(id)];
    if (nm) return countryFromName(nm);
  }
  if (bin && String(bin).replace(/\D/g, '').length === 12) return 'KZ';
  return '';
}

module.exports = { loadGeoDir, countryFromName, resolveCountry, GEO_FIELD_COMPANY, GEO_FIELD_DEAL, COUNTRY };

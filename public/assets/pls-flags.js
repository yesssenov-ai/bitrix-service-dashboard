/* Общие флаги стран для ЦУП. SVG (не emoji — на Windows не рисуются).
   Два пути: flagHtml(ISO2), flagByName(текст страны/региона), flagByCompany(название).
   flagByCompany использует карту «название компании → страна» из /api/companies/country-map. */
(function (w) {
  var CNAME = { KZ: 'Казахстан', UZ: 'Узбекистан', KG: 'Кыргызстан', TJ: 'Таджикистан', TM: 'Туркменистан', AZ: 'Азербайджан', AM: 'Армения', GE: 'Грузия', RU: 'Россия', BY: 'Беларусь', UA: 'Украина', MD: 'Молдова', MN: 'Монголия', CN: 'Китай', TR: 'Турция', IR: 'Иран', AF: 'Афганистан', IN: 'Индия', PK: 'Пакистан', AE: 'ОАЭ', SA: 'Саудовская Аравия', DE: 'Германия', FR: 'Франция', US: 'США', KR: 'Корея', JP: 'Япония' };
  var FLAGS = {
    KZ: '<rect width="18" height="12" fill="#00AFCA"/><circle cx="9" cy="6" r="2.3" fill="#FEC50C"/>',
    UZ: '<rect width="18" height="12" fill="#1EB53A"/><rect width="18" height="8" fill="#fff"/><rect width="18" height="4" fill="#0099B5"/><rect y="3.5" width="18" height=".5" fill="#CE1126"/><rect y="8" width="18" height=".5" fill="#CE1126"/><circle cx="3.3" cy="2" r="1.3" fill="#fff"/><circle cx="3.9" cy="2" r="1.1" fill="#0099B5"/>',
    KG: '<rect width="18" height="12" fill="#E8112D"/><circle cx="9" cy="6" r="2.2" fill="#FFEF00"/>',
    TJ: '<rect width="18" height="12" fill="#006600"/><rect width="18" height="8.4" fill="#fff"/><rect width="18" height="3.6" fill="#CC0000"/><rect x="7.3" y="4.8" width="3.4" height="2.4" fill="#F8C300"/>',
    TM: '<rect width="18" height="12" fill="#28AE66"/><rect x="2.3" width="2.6" height="12" fill="#CE1126"/>',
    AZ: '<rect width="18" height="12" fill="#3F9C35"/><rect width="18" height="8" fill="#ED2939"/><rect width="18" height="4" fill="#00B5E2"/><circle cx="8.4" cy="6" r="1.7" fill="#fff"/><circle cx="9.1" cy="6" r="1.4" fill="#ED2939"/>',
    AM: '<rect width="18" height="12" fill="#D90012"/><rect y="4" width="18" height="4" fill="#0033A0"/><rect y="8" width="18" height="4" fill="#F2A800"/>',
    GE: '<rect width="18" height="12" fill="#fff"/><rect x="7.6" width="2.8" height="12" fill="#F00"/><rect y="4.6" width="18" height="2.8" fill="#F00"/>',
    RU: '<rect width="18" height="12" fill="#fff"/><rect y="4" width="18" height="4" fill="#0039A6"/><rect y="8" width="18" height="4" fill="#D52B1E"/>',
    BY: '<rect width="18" height="12" fill="#C8313E"/><rect y="8.4" width="18" height="3.6" fill="#4AA657"/><rect width="2.6" height="12" fill="#fff"/><rect x="1" width=".5" height="12" fill="#C8313E"/>',
    UA: '<rect width="18" height="12" fill="#FFD500"/><rect width="18" height="6" fill="#0057B7"/>',
    MD: '<rect width="18" height="12" fill="#CC092F"/><rect width="12" height="12" fill="#FFD200"/><rect width="6" height="12" fill="#0046AE"/>',
    MN: '<rect width="18" height="12" fill="#C4272E"/><rect x="6" width="6" height="12" fill="#015197"/>',
    CN: '<rect width="18" height="12" fill="#DE2910"/><text x="2.2" y="5.6" font-size="4.4" fill="#FFDE00">★</text>',
    TR: '<rect width="18" height="12" fill="#E30A17"/><circle cx="7" cy="6" r="2.2" fill="#fff"/><circle cx="7.8" cy="6" r="1.8" fill="#E30A17"/><text x="9.2" y="7.5" font-size="3.6" fill="#fff">★</text>',
    IR: '<rect width="18" height="12" fill="#fff"/><rect width="18" height="4" fill="#239F40"/><rect y="8" width="18" height="4" fill="#DA0000"/>',
    AE: '<rect width="18" height="12" fill="#fff"/><rect width="18" height="4" fill="#00732F"/><rect y="8" width="18" height="4" fill="#000"/><rect width="5" height="12" fill="#FF0000"/>',
    DE: '<rect width="18" height="12" fill="#FFCE00"/><rect width="18" height="8" fill="#D00"/><rect width="18" height="4" fill="#000"/>',
    FR: '<rect width="18" height="12" fill="#fff"/><rect width="6" height="12" fill="#0055A4"/><rect x="12" width="6" height="12" fill="#EF4135"/>',
    US: '<rect width="18" height="12" fill="#fff"/><rect y="1.7" width="18" height="1.7" fill="#B22234"/><rect y="5.1" width="18" height="1.7" fill="#B22234"/><rect y="8.5" width="18" height="1.7" fill="#B22234"/><rect width="8" height="6.8" fill="#3C3B6E"/>',
    KR: '<rect width="18" height="12" fill="#fff"/><circle cx="9" cy="6" r="2.4" fill="#CD2E3A"/><path d="M6.6 6a2.4 2.4 0 0 1 4.8 0 1.2 1.2 0 0 1-2.4 0 1.2 1.2 0 0 0-2.4 0z" fill="#0047A0"/>',
    JP: '<rect width="18" height="12" fill="#fff"/><circle cx="9" cy="6" r="2.6" fill="#BC002D"/>',
  };
  // Название страны (рус.) → ISO2. Всё, что не страна, — Казахстан (регион/город РК).
  var COUNTRY = { 'казахстан': 'KZ', 'узбекистан': 'UZ', 'кыргызстан': 'KG', 'киргизия': 'KG', 'таджикистан': 'TJ', 'туркменистан': 'TM', 'туркмения': 'TM', 'азербайджан': 'AZ', 'армения': 'AM', 'грузия': 'GE', 'россия': 'RU', 'российская федерация': 'RU', 'беларусь': 'BY', 'белоруссия': 'BY', 'украина': 'UA', 'молдова': 'MD', 'молдавия': 'MD', 'монголия': 'MN', 'китай': 'CN', 'кнр': 'CN', 'турция': 'TR', 'иран': 'IR', 'афганистан': 'AF', 'индия': 'IN', 'пакистан': 'PK', 'оаэ': 'AE', 'объединённые арабские эмираты': 'AE', 'саудовская аравия': 'SA', 'германия': 'DE', 'франция': 'FR', 'сша': 'US', 'южная корея': 'KR', 'корея': 'KR', 'япония': 'JP' };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function flagHtml(code) {
    if (!code) return '';
    var nm = CNAME[code] || code, inner = FLAGS[code];
    var svg = '<svg class="flag" width="18" height="12" viewBox="0 0 18 12" aria-label="' + esc(nm) + '">' + (inner || ('<rect width="18" height="12" fill="#e7eaf0"/><text x="9" y="8.7" text-anchor="middle" font-size="6" fill="#6a7488" font-family="system-ui">' + esc(code) + '</text>')) + '</svg>';
    return '<span class="flagw" title="' + esc(nm) + '">' + svg + '</span>';
  }
  function countryFromName(name) {
    var n = String(name == null ? '' : name).trim().toLowerCase().replace(/ё/g, 'е');
    if (!n) return '';
    for (var k in COUNTRY) if (n === k || n.indexOf(k) >= 0) return COUNTRY[k];
    return 'KZ';
  }
  function flagByName(name) { return flagHtml(countryFromName(name)); }

  // Нормализация названия компании для матча с зеркалом.
  var ORG = { 'тоо': 1, 'ооо': 1, 'оао': 1, 'зао': 1, 'ао': 1, 'пао': 1, 'ип': 1, 'чп': 1, 'чк': 1, 'ргп': 1, 'кгп': 1, 'гу': 1, 'то': 1, 'на': 1, 'пхв': 1, 'ltd': 1, 'llp': 1, 'llc': 1, 'inc': 1, 'gmbh': 1, 'co': 1, 'corp': 1, 'company': 1, 'limited': 1 };
  function normCompany(s) {
    var toks = String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').replace(/[«»"'`“”„]/g, ' ').split(/[^a-zа-я0-9]+/);
    var out = [];
    for (var i = 0; i < toks.length; i++) if (toks[i] && !ORG[toks[i]]) out.push(toks[i]);
    return out.join(' ').trim();
  }
  var _map = null, _mapP = null;
  function loadCountryMap() {
    if (_map) return Promise.resolve(_map);
    if (_mapP) return _mapP;
    _mapP = fetch('/api/companies/country-map').then(function (r) { return r.ok ? r.json() : {}; }).then(function (d) {
      var raw = (d && d.map) || {}; var m = {};
      for (var k in raw) m[k] = raw[k];
      _map = m; return m;
    }).catch(function () { _map = {}; return _map; });
    return _mapP;
  }
  function flagByCompany(name) {
    if (!_map) return '';
    var code = _map[normCompany(name)] || '';
    return flagHtml(code);
  }
  w.PLSFlags = { flagHtml: flagHtml, flagByName: flagByName, flagByCompany: flagByCompany, countryFromName: countryFromName, normCompany: normCompany, loadCountryMap: loadCountryMap, CNAME: CNAME };
  // глобальные короткие алиасы
  w.flagHtml = flagHtml; w.flagByName = flagByName; w.flagByCompany = flagByCompany;
  // единый стиль флага на любой странице
  try { var st = document.createElement('style'); st.textContent = '.flag{display:inline-block;vertical-align:-2px;margin-right:6px;flex:none;box-shadow:0 0 0 .5px rgba(0,0,0,.12);border-radius:2.5px}.flagw{display:inline-flex;align-items:center}'; (document.head || document.documentElement).appendChild(st); } catch (e) {}
})(window);

const fetch = require('node-fetch');
const { SERVICE_TYPES } = require('./constants');

// ── Field mappings for entityTypeId=1042 ─────────────────────────────────────
const F42 = {
  address:      'ufCrm4_1732874599769',
  deviceType:   'ufCrm4_1732874589657',
  catalogNum:   'ufCrm4_1732875139913',
  serialNum:    'ufCrm4_1732875152873',
  hasWarranty:  'ufCrm4_1732875202465',
  warrantyStart:'ufCrm4_1732875215633',
  warrantyEnd:  'ufCrm4_1732875224194',
  seller:       'ufCrm4_1744612973694',
  manufacturer: 'ufCrmProizvoditel',
  deviceName:   'ufCrmPribor',
  serviceStart: 'ufCrm4_1732874669664',
  serviceEnd:   'ufCrm4_1732874679233',
};

// Связь заявки (1058) с оборудованием (1042) и локацией:
const EQ_LINK_MULTI  = 'ufCrm8_1761652570';   // «Учёт оборудования клиентов (мнж)»  (crm, множ)
const EQ_LINK_SINGLE = 'ufCrm8_1732855706';   // «Учёт оборудования клиентов (немнж)» (crm)
const PLACE_FIELD    = 'ufCrm8_1732855494458'; // «Место проведения работ» (текст: город/локация)

const DEVICE_TYPE = { '2110':'Основное', '2111':'Периферийное' };
const WARRANTY    = { '2361':'Есть',     '2362':'Нет' };
const SELLER      = { '3603':'ProLabSupport', '3604':'Сторонний продавец' };

const MANUFACTURERS = {
  '2112':'Agilent Technologies','2113':'Metrohm','2114':'Malvern Panalytical',
  '2115':'LECO','2116':'Wasson','2117':'LNI','2118':'Peak Scientific',
  '2119':'Metrohm Autolab','2123':'ELGA LabWater','5799':'Waters',
  '2124':'Другое','8504':'Olympus',
};

// ── City parser ────────────────────────────────────────────────────────────────
const REGION_WORDS = new Set([
  'республика','рк','казахстан','узбекистан','кыргызстан','таджикистан',
  'область','акмолинская','туркестанская','карагандинская','актюбинская',
  'восточная','западная','северная','южная','павлодарская','костанайская',
  'жамбылская','атырауская','мангистауская','алматинская','абайская',
  'улытауская','жетысуская','восточно','западно','северо','южно',
]);
const COUNTRY_WORDS = new Set(['казахстан','узбекистан','кыргызстан','таджикистан','россия']);
const SKIP_PATTERNS = /область|район|р-он|р-н|месторожден|лаборатор|промзон|промышлен|металлург|физ\.|хим\.|рудник|участок|корпус/i;

function extractCity(address) {
  if (!address || !address.trim()) return null;
  const s = address.trim();

  // 1. "г. Город" — only when preceded by start, comma, or space
  let m = s.match(/(?:^|[,\s])г\.?\s*([А-ЯЁа-яё][А-ЯЁа-яё\w-]*(?:[- ][А-ЯЁа-яё][А-ЯЁа-яё\w-]*)?)/u);
  if (m) return m[1].trim();

  // 2. "с. / п. / пгт." — village/settlement
  m = s.match(/(?:^|,)\s*(?:с|п|пгт)\.?\s+([А-ЯЁа-яё][А-ЯЁа-яё\w-]+)/u);
  if (m) return m[1].trim();

  // 3. "Зерендинский р-он" → "Зерендинский"
  m = s.match(/([А-ЯЁа-яё][А-ЯЁа-яё\w-]+)\s+(?:р-он|р-н|район)/iu);
  if (m) return m[1].trim();

  // 4. Walk comma-separated parts, pick first useful token
  const parts = s.split(',');
  for (const part of parts) {
    const t = part.trim();
    if (t.length < 3) continue;
    const firstWord = t.split(/\s+/)[0].toLowerCase().replace(/[.,]/g, '');
    if (REGION_WORDS.has(firstWord) || COUNTRY_WORDS.has(firstWord)) continue;
    if (SKIP_PATTERNS.test(t)) continue;
    if (/^ул\.|^пр\.|^бул\.|^пер\.|^\d/.test(t)) continue;
    const clean = t.replace(/^[гсп]\.?\s*/iu, '').trim();
    if (clean.length > 2) return clean.split(/[,\s]/)[0].trim();
  }
  return null;
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val.map(String) : [String(val)];
}

function enrichEquipment(item) {
  const mfrIds = toArray(item[F42.manufacturer]);
  const mfr = mfrIds.map(id => MANUFACTURERS[id] || `#${id}`).join(', ') || null;
  const address = (item[F42.address] || '').trim();
  return {
    id: item.id,
    title: item.title || `#${item.id}`,
    companyId: item.companyId,
    companyName: null,
    address,
    city: extractCity(address),
    deviceType: DEVICE_TYPE[String(item[F42.deviceType])] || null,
    catalogNums: toArray(item[F42.catalogNum]),
    serialNums: toArray(item[F42.serialNum]),
    manufacturer: mfr,
    manufacturerIds: mfrIds,
    deviceNameIds: toArray(item[F42.deviceName]),
    hasWarranty: WARRANTY[String(item[F42.hasWarranty])] || null,
    warrantyStart: item[F42.warrantyStart] || null,
    warrantyEnd: item[F42.warrantyEnd] || null,
    seller: SELLER[String(item[F42.seller])] || null,
    serviceStart: item[F42.serviceStart] || null,
    serviceEnd: item[F42.serviceEnd] || null,
    stageId: item.stageId,
    updatedTime: item.updatedTime || null,
    url: `https://crm.prolabsupport.kz/crm/type/1042/details/${item.id}/`,
    activeTickets: [],
    hasProblems: false,
    lat: null, lng: null,
  };
}

// ── Fetch equipment (1042). extraFilter — для инкрементальной подгрузки
// (напр. { '>updatedTime': '2026-08-01T00:00:00' } — только изменённые). ─────────
async function fetchAllEquipment(b24call, extraFilter) {
  const items = [];
  let start = 0;
  while (true) {
    const params = {
      entityTypeId: 1042,
      select: ['id','title','companyId','stageId','updatedTime',
        F42.address, F42.deviceType, F42.catalogNum, F42.serialNum,
        F42.manufacturer, F42.deviceName, F42.hasWarranty,
        F42.warrantyStart, F42.warrantyEnd, F42.seller,
        F42.serviceStart, F42.serviceEnd],
      order: { id: 'ASC' },
      start,
    };
    if (extraFilter) params.filter = extraFilter;
    const data = await b24call('crm.item.list', params);
    const batch = data.result?.items || [];
    if (!batch.length) break;
    items.push(...batch.map(enrichEquipment));
    const total = data.total ?? items.length;
    start = items.length;
    if (!data.next || items.length >= total) break;
    await new Promise(r => setTimeout(r, 300));
  }
  return items;
}

// ── Fetch device name enum values (for filter UI) ─────────────────────────────
async function fetchDeviceNames(b24call) {
  try {
    const data = await b24call('crm.item.fields', { entityTypeId: 1042 });
    const field = data.result?.fields?.ufCrmPribor;
    if (!field?.items) return {};
    const map = {};
    for (const item of field.items) map[String(item.ID)] = item.VALUE;
    return map;
  } catch(e) {
    console.error('fetchDeviceNames error:', e.message);
    return {};
  }
}

// ── Сервисные заявки (1058) → тип/срочность/категория ────────────────────────
const SERVICE_TYPE_FIELD = 'ufCrm8_1744300223';       // «Тип оказываемых услуг (УС)»
const URGENT_FIELD = 'ufCrm8_1732856215147';          // «Заявка просрочена» (Да=1807) → горящие
const URGENT_YES = '1807';
const INSTALL_TYPE_ID = '103';                        // «Установка»
const CLIENT_REQUEST_TYPE = '619';                    // «Заявка клиента» → Tickets (приоритет)

// crm-поля возвращают ссылки строкой ("1042_1607", "T4c_1042_1607" и т.п.) —
// берём завершающие цифры как id элемента 1042.
function extractIds(val) {
  return toArray(val).map(v => { const m = String(v).match(/(\d+)\s*$/); return m ? Number(m[1]) : null; }).filter(Boolean);
}
const SERVICE_TYPE_MAP = {
  '103': 'Установка', '104': 'Техническое обслуживание', '105': 'Диагностика', '106': 'Ремонт',
  '107': 'Методическое сопровождение', '108': 'Обучение сервисного отдела', '109': 'Обучение ТЦ',
  '110': 'Квалификация', '111': 'Подбор дополнительного оборудования',
  '112': 'Подбор расходки / запасных частей', '113': 'Претензия',
  '114': 'Другое', '402': 'Подготовка документов', '619': 'Заявка клиента',
};
const isFinalStage = s => /:(SUCCESS|FAIL)$/i.test(String(s || '')) || s === 'DT1058_11:4';

// Категории 1058 (id → имя): Тикеты, Обязательства, Заявка на сервис и т.д. — для фильтра.
async function fetchServiceCategories(b24call) {
  try {
    const data = await b24call('crm.category.list', { entityTypeId: 1058 });
    const map = {};
    (data.result?.categories || []).forEach(c => { map[String(c.id)] = c.name; });
    return map;
  } catch (e) { console.error('fetchServiceCategories:', e.message); return {}; }
}

// ── Тянем ВСЕ незавершённые заявки (1058), размечаем тип/срочность/связь ──────
// Каждая заявка: kind (горящая/установка/сервис), список типов услуг, ссылки на
// оборудование (Учёт оборудования клиентов) и «Место проведения работ» — позже
// позиционируем на карте.
async function fetchTickets(b24call, categoryNames = {}) {
  const tickets = [];
  let start = 0;
  while (true) {
    const data = await b24call('crm.item.list', {
      entityTypeId: 1058,
      select: ['id','title','stageId','companyId','categoryId',
        SERVICE_TYPE_FIELD, URGENT_FIELD, EQ_LINK_MULTI, EQ_LINK_SINGLE, PLACE_FIELD],
      order: { id: 'DESC' }, start,
    });
    const batch = data.result?.items || [];
    if (!batch.length) break;
    for (const t of batch) {
      if (isFinalStage(t.stageId)) continue;
      const serviceTypeIds = toArray(t[SERVICE_TYPE_FIELD]);
      const serviceTypeLabel = serviceTypeIds.map(id => SERVICE_TYPE_MAP[id] || `#${id}`).join(', ') || '—';
      const urgent = String(t[URGENT_FIELD]) === URGENT_YES;
      const isInstall = serviceTypeIds.includes(INSTALL_TYPE_ID);
      const isTicket = serviceTypeIds.includes(CLIENT_REQUEST_TYPE);
      const kind = urgent ? 'urgent' : (isInstall ? 'install' : 'service');
      const eqLinkIds = [...new Set([...extractIds(t[EQ_LINK_MULTI]), ...extractIds(t[EQ_LINK_SINGLE])])];
      const catId = String(t.categoryId);
      tickets.push({
        id: t.id, title: t.title, stageId: t.stageId, companyId: t.companyId,
        categoryId: catId, categoryName: categoryNames[catId] || ('Категория ' + catId),
        serviceTypeIds, serviceTypeLabel, urgent, isTicket, kind, eqLinkIds,
        placeText: (t[PLACE_FIELD] || '').trim() || null,
        lat: null, lng: null, city: null, eqTitle: null, via: null,
        url: `https://crm.prolabsupport.kz/crm/type/1058/details/${t.id}/`,
      });
    }
    const total = data.total ?? (start + batch.length);
    start += batch.length;
    if (!data.next || start >= total) break;
  }
  return tickets;
}

// ── Позиционируем заявки на карте ────────────────────────────────────────────
// Приоритет локации: (1) привязанное оборудование → его координаты;
// (2) «Место проведения работ» → геокодируем; (3) компания → её оборудование.
// Заодно помечаем оборудование hasProblems, если на него висит горящая заявка.
async function positionTickets(tickets, equipmentArray, pool) {
  const eqById = {}, companyEq = {};
  for (const e of equipmentArray) {
    eqById[e.id] = e;
    if (e.companyId) (companyEq[e.companyId] = companyEq[e.companyId] || []).push(e);
  }
  const pickCoordEq = list => list.find(e => e.lat && e.lng) || null;
  const pushT = (e, t) => { if (!e) return; (e.activeTickets = e.activeTickets || []).push({ id: t.id, title: t.title, stageId: t.stageId, isOverdue: t.urgent, kind: t.kind, url: t.url }); };

  // 1) оборудование по ссылке — привязываем заявку ко ВСЕМ связанным приборам,
  //    координаты берём с первого прибора, у которого они есть.
  const placesToGeocode = new Set();
  for (const t of tickets) {
    for (const id of t.eqLinkIds) {
      const e = eqById[id];
      if (!e) continue;
      pushT(e, t);
      if (!t.eqTitle) { t.eqTitle = e.title; t.city = t.city || e.city; }
      if (!t.lat && e.lat && e.lng) { t.lat = e.lat; t.lng = e.lng; t.city = e.city; t.via = 'equipment'; }
    }
    if (!t.lat && t.placeText) placesToGeocode.add(t.placeText.toLowerCase());
  }

  // 2) геокодируем «Место проведения работ»
  const placeCoords = await geocodePlaces([...placesToGeocode], pool);

  // 3) добиваем: место → компания
  for (const t of tickets) {
    if (!t.lat && t.placeText) {
      const c = placeCoords[t.placeText.toLowerCase()];
      if (c) { t.lat = c.lat; t.lng = c.lng; t.city = t.city || t.placeText; t.via = 'place'; }
    }
    if (!t.lat && t.companyId && companyEq[t.companyId]) {
      const e = pickCoordEq(companyEq[t.companyId]);
      if (e) { t.lat = e.lat; t.lng = e.lng; t.city = e.city; t.eqTitle = t.eqTitle || e.title; t.via = 'company'; if (!t.eqLinkIds.length) pushT(e, t); }
    }
    // отметить связанное оборудование как проблемное, если заявка горящая
    if (t.urgent) {
      t.eqLinkIds.forEach(id => { const e = eqById[id]; if (e) e.hasProblems = true; });
      if (t.via === 'company' && companyEq[t.companyId]) { const e = pickCoordEq(companyEq[t.companyId]); if (e) e.hasProblems = true; }
    }
  }
  return tickets;
}

// ── Fetch company names ────────────────────────────────────────────────────────
async function fetchCompanyNames(companyIds, b24call) {
  const names = {};
  const unique = [...new Set(companyIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    try {
      const data = await b24call('crm.company.list', {
        filter: { ID: unique.slice(i, i + 50) },
        select: ['ID','TITLE'],
      });
      for (const c of (data.result || [])) names[c.ID] = c.TITLE;
    } catch(e) { console.error('fetchCompanyNames error:', e.message); }
  }
  return names;
}

// ── Geocode city via Nominatim ────────────────────────────────────────────────
const cityCoordCache = {};

const COUNTRY_MAP = {
  'узбекистан': 'Uzbekistan',
  'кыргызстан': 'Kyrgyzstan',
  'киргизия': 'Kyrgyzstan',
  'таджикистан': 'Tajikistan',
  'туркменистан': 'Turkmenistan',
  'россия': 'Russia',
  'азербайджан': 'Azerbaijan',
  'грузия': 'Georgia',
  'монголия': 'Mongolia',
};

function detectCountry(address) {
  if (!address) return 'Kazakhstan';
  const lower = address.toLowerCase();
  for (const [word, country] of Object.entries(COUNTRY_MAP)) {
    if (lower.includes(word)) return country;
  }
  return 'Kazakhstan';
}

async function geocodeCity(city, country = 'Kazakhstan') {
  if (!city) return null;
  const key = `${city}|${country}`;
  if (cityCoordCache[key] !== undefined) return cityCoordCache[key];

  try {
    const query = `${city}, ${country}`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ProLabSupport-EquipmentMap/1.0 (service@prolabsupport.kz)' }
    });
    const data = await res.json();
    const result = data.length > 0 ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) } : null;
    cityCoordCache[key] = result;
    return result;
  } catch(e) {
    cityCoordCache[key] = null;
    return null;
  }
}

async function geocodeEquipment(items, pool) {
  const results = [];
  for (const item of items) {
    if (!item.city) { results.push(item); continue; }

    // Check DB cache by item_id
    const cached = await pool.query(
      'SELECT lat, lng, geocode_failed FROM ticketsmodule_equipment_geo WHERE item_id=$1', [item.id]
    );
    if (cached.rows.length > 0) {
      const r = cached.rows[0];
      results.push({ ...item, lat: r.lat, lng: r.lng, geocodeFailed: r.geocode_failed });
      continue;
    }

    // Detect country from original address, geocode by city
    const country = detectCountry(item.address);
    await new Promise(r => setTimeout(r, 1100));
    const coords = await geocodeCity(item.city, country);

    await pool.query(
      `INSERT INTO ticketsmodule_equipment_geo (item_id, address, lat, lng, geocode_failed)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (item_id) DO UPDATE SET address=$2, lat=$3, lng=$4, geocode_failed=$5, geocoded_at=NOW()`,
      [item.id, item.city, coords?.lat || null, coords?.lng || null, !coords]
    );
    results.push({ ...item, lat: coords?.lat || null, lng: coords?.lng || null });
  }
  return results;
}

// ── Геокодирование «Место проведения работ» (текст: город/локация) ───────────
// Кэш в таблице ticketsmodule_place_geo (ключ — нормализованный текст места).
async function geocodePlaces(places, pool) {
  const out = {};
  for (const place of places) {
    if (!place) continue;
    const key = String(place).toLowerCase().trim();
    if (!key) continue;
    try {
      const cached = await pool.query('SELECT lat, lng FROM ticketsmodule_place_geo WHERE place=$1', [key]);
      if (cached.rows.length) { const r = cached.rows[0]; if (r.lat != null) out[key] = { lat: r.lat, lng: r.lng }; continue; }
    } catch (e) { /* таблицы может не быть на первом прогоне — создаётся в routes */ }
    const country = detectCountry(key);
    await new Promise(r => setTimeout(r, 1100));
    const coords = await geocodeCity(place, country);
    try {
      await pool.query(
        `INSERT INTO ticketsmodule_place_geo (place, lat, lng, geocode_failed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (place) DO UPDATE SET lat=$2, lng=$3, geocode_failed=$4, geocoded_at=NOW()`,
        [key, coords?.lat || null, coords?.lng || null, !coords]
      );
    } catch (e) {}
    if (coords) out[key] = coords;
  }
  return out;
}

module.exports = {
  fetchAllEquipment, fetchTickets, positionTickets, fetchServiceCategories, fetchCompanyNames,
  geocodeEquipment, geocodePlaces, fetchDeviceNames, MANUFACTURERS, SERVICE_TYPE_MAP, extractCity,
};

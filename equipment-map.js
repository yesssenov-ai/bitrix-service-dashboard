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

const F58_EQUIPMENT_LINK = 'ufCrm8_1732855747';

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
    url: `https://crm.prolabsupport.kz/crm/type/1042/details/${item.id}/`,
    activeTickets: [],
    hasProblems: false,
    lat: null, lng: null,
  };
}

// ── Fetch all equipment (1042) ─────────────────────────────────────────────────
async function fetchAllEquipment(b24call) {
  const items = [];
  let start = 0;
  while (true) {
    const data = await b24call('crm.item.list', {
      entityTypeId: 1042,
      select: ['id','title','companyId','stageId',
        F42.address, F42.deviceType, F42.catalogNum, F42.serialNum,
        F42.manufacturer, F42.deviceName, F42.hasWarranty,
        F42.warrantyStart, F42.warrantyEnd, F42.seller,
        F42.serviceStart, F42.serviceEnd],
      order: { id: 'ASC' },
      start,
    });
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

// ── Link tickets to equipment via ufCrm8_1732855747 ──────────────────────────
async function fetchAndLinkTickets(equipmentMap, b24call) {
  const FINAL = new Set(['DT1058_11:SUCCESS','DT1058_11:FAIL','DT1058_11:4']);
  let start = 0;
  while (true) {
    const data = await b24call('crm.item.list', {
      entityTypeId: 1058,
      filter: { categoryId: 11 },
      select: ['id','title','stageId','companyId', F58_EQUIPMENT_LINK, 'ufCrm8_1732856215147'],
      order: { id: 'DESC' },
      start,
    });
    const batch = data.result?.items || [];
    if (!batch.length) break;
    for (const t of batch) {
      if (FINAL.has(t.stageId)) continue;
      for (const eqId of toArray(t[F58_EQUIPMENT_LINK]).map(Number)) {
        if (!equipmentMap[eqId]) continue;
        const ticket = {
          id: t.id, title: t.title, stageId: t.stageId,
          isOverdue: t.ufCrm8_1732856215147 === '1807',
          url: `https://crm.prolabsupport.kz/crm/type/1058/details/${t.id}/`,
        };
        equipmentMap[eqId].activeTickets.push(ticket);
        if (ticket.isOverdue) equipmentMap[eqId].hasProblems = true;
      }
    }
    const total = data.total ?? (start + batch.length);
    start += batch.length;
    if (!data.next || start >= total) break;
  }
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

async function geocodeCity(city, country = 'Казахстан') {
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

    // Geocode by city (much more reliable than full address)
    await new Promise(r => setTimeout(r, 1100));
    const coords = await geocodeCity(item.city);

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

module.exports = {
  fetchAllEquipment, fetchAndLinkTickets, fetchCompanyNames,
  geocodeEquipment, fetchDeviceNames, MANUFACTURERS, extractCity,
};

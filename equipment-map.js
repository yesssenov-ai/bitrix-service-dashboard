const fetch = require('node-fetch');

// ── Field mappings for entityTypeId=1042 (Учёт оборудования) ─────────────────
const F42 = {
  endUser:      'ufCrm4_1732874549',
  deviceType:   'ufCrm4_1732874589657',
  address:      'ufCrm4_1732874599769',
  serviceStart: 'ufCrm4_1732874669664',
  serviceEnd:   'ufCrm4_1732874679233',
  catalogNum:   'ufCrm4_1732875139913',
  serialNum:    'ufCrm4_1732875152873',
  hasWarranty:  'ufCrm4_1732875202465',
  warrantyStart:'ufCrm4_1732875215633',
  warrantyEnd:  'ufCrm4_1732875224194',
  seller:       'ufCrm4_1744612973694',
  manufacturer: 'ufCrmProizvoditel',
  deviceName:   'ufCrmPribor',
};

// ── Field in 1058 (Заявка на сервис) that links to 1042 item ─────────────────
const F58_EQUIPMENT_LINK = 'ufCrm8_1732855747'; // "Учёт оборудования" → [itemId 1042]

const DEVICE_TYPE = { '2110':'Основное', '2111':'Периферийное' };
const WARRANTY    = { '2361':'Есть', '2362':'Нет' };
const SELLER      = { '3603':'ProLabSupport', '3604':'Сторонний продавец' };
const MANUFACTURERS = {
  '2112':'Agilent Technologies','2113':'Metrohm','2114':'Malvern Panalytical',
  '2115':'LECO','2116':'Wasson','2117':'LNI','2118':'Peak Scientific',
  '2119':'Metrohm Autolab','2123':'ELGA LabWater','5799':'Waters',
  '2124':'Другое','8504':'Olympus',
};

function enrichEquipment(item) {
  const mfr = Array.isArray(item[F42.manufacturer])
    ? item[F42.manufacturer].map(id => MANUFACTURERS[String(id)] || `#${id}`).join(', ')
    : MANUFACTURERS[String(item[F42.manufacturer])] || null;
  return {
    id: item.id,
    title: item.title || `#${item.id}`,
    companyId: item.companyId,
    address: (item[F42.address] || '').trim(),
    deviceType: DEVICE_TYPE[String(item[F42.deviceType])] || null,
    catalogNums: toArray(item[F42.catalogNum]),
    serialNums: toArray(item[F42.serialNum]),
    manufacturer: mfr,
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
  };
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// ── Fetch all equipment from 1042 ─────────────────────────────────────────────
async function fetchAllEquipment(b24call) {
  const items = [];
  let start = 0;
  while (true) {
    const data = await b24call('crm.item.list', {
      entityTypeId: 1042,
      select: ['id','title','companyId','stageId','categoryId',
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
    const total = data.total ?? data.result?.total ?? items.length;
    start = items.length;
    if (!data.next || items.length >= total) break;
  }
  return items;
}

// ── Fetch active service tickets and link them to equipment items ──────────────
async function fetchAndLinkTickets(equipmentMap, b24call) {
  // Fetch all non-final tickets
  const FINAL_STAGES = new Set(['DT1058_11:SUCCESS','DT1058_11:FAIL','DT1058_11:4']);
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
      if (FINAL_STAGES.has(t.stageId)) continue; // skip closed tickets

      // Get linked equipment IDs
      const linkedIds = toArray(t[F58_EQUIPMENT_LINK]).map(v => parseInt(String(v)));
      for (const eqId of linkedIds) {
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

    const total = data.total ?? data.result?.total ?? (start + batch.length);
    start += batch.length;
    if (!data.next || start >= total) break;
  }
}

// ── Fetch company names by IDs ─────────────────────────────────────────────────
async function fetchCompanyNames(companyIds, b24call) {
  const names = {};
  const unique = [...new Set(companyIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    try {
      const data = await b24call('crm.company.list', {
        filter: { ID: batch },
        select: ['ID', 'TITLE'],
      });
      for (const c of (data.result || [])) names[c.ID] = c.TITLE;
    } catch(e) { console.error('fetchCompanyNames error:', e.message); }
  }
  return names;
}

// ── Geocode via Nominatim (1 req/sec, KZ context) ────────────────────────────
async function geocodeAddress(address) {
  if (!address || address.length < 5) return null;
  try {
    const query = address.includes('Казахстан') ? address : address + ', Казахстан';
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=kz`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ProLabSupport-EquipmentMap/1.0 (service@prolabsupport.kz)' } });
    const data = await res.json();
    if (data.length > 0) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    return null;
  } catch(e) { return null; }
}

async function geocodeEquipment(items, pool) {
  const results = [];
  for (const item of items) {
    if (!item.address) { results.push({ ...item, lat: null, lng: null }); continue; }
    const cached = await pool.query(
      'SELECT lat, lng, geocode_failed FROM ticketsmodule_equipment_geo WHERE item_id=$1', [item.id]
    );
    if (cached.rows.length > 0) {
      const row = cached.rows[0];
      results.push({ ...item, lat: row.lat, lng: row.lng, geocodeFailed: row.geocode_failed });
      continue;
    }
    await new Promise(r => setTimeout(r, 1100));
    const coords = await geocodeAddress(item.address);
    await pool.query(
      `INSERT INTO ticketsmodule_equipment_geo (item_id, address, lat, lng, geocode_failed)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (item_id) DO UPDATE
       SET address=$2, lat=$3, lng=$4, geocode_failed=$5, geocoded_at=NOW()`,
      [item.id, item.address, coords?.lat||null, coords?.lng||null, !coords]
    );
    results.push({ ...item, lat: coords?.lat||null, lng: coords?.lng||null, geocodeFailed: !coords });
  }
  return results;
}

module.exports = { fetchAllEquipment, fetchAndLinkTickets, fetchCompanyNames, geocodeEquipment, MANUFACTURERS };

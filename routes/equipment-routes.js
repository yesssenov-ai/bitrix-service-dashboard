const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const {
  fetchAllEquipment, fetchAndLinkTickets, fetchCompanyNames,
  geocodeEquipment, fetchDeviceNames, MANUFACTURERS,
} = require('../equipment-map');

let b24callFn = null;
function setB24(fn) { b24callFn = fn; }

let cache = null;
let cacheTs = 0;
let deviceNamesCache = {};
const CACHE_TTL = 15 * 60 * 1000;

async function buildCache(force = false) {
  const now = Date.now();
  if (cache && !force && (now - cacheTs) < CACHE_TTL) return cache;

  console.log('🔄 Loading equipment from Б24...');
  let rawItems = [];
  try { rawItems = await fetchAllEquipment(b24callFn); }
  catch(e) { throw new Error('Ошибка загрузки оборудования: ' + e.message); }

  const equipmentMap = {};
  for (const item of rawItems) equipmentMap[item.id] = item;

  try { await fetchAndLinkTickets(equipmentMap, b24callFn); } catch(e) { console.error('tickets link error:', e.message); }

  try {
    const ids = [...new Set(rawItems.map(e => e.companyId).filter(Boolean))];
    const names = await fetchCompanyNames(ids, b24callFn);
    for (const item of rawItems) {
      if (item.companyId) item.companyName = names[item.companyId] || null;
    }
  } catch(e) { console.error('company names error:', e.message); }

  // Geocode by city (much faster and more reliable)
  try {
    const withCoords = await geocodeEquipment(rawItems, pool);
    cache = withCoords;
  } catch(e) {
    console.error('geocode error:', e.message);
    cache = rawItems;
  }

  // Fetch device names enum
  try { deviceNamesCache = await fetchDeviceNames(b24callFn); } catch(e) {}

  cacheTs = now;
  console.log(`✅ Equipment loaded: ${cache.length} items`);
  return cache;
}

// GET /equipment/map-data
router.get('/map-data', requireAuth(), async (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const items = await buildCache(force);
    const { status, manufacturer, deviceName, city, company } = req.query;

    let filtered = items;
    if (status === 'prolab')   filtered = filtered.filter(e => e.seller === 'ProLabSupport');
    if (status === 'third')    filtered = filtered.filter(e => e.seller === 'Сторонний продавец');
    if (status === 'warranty') filtered = filtered.filter(e => e.hasWarranty === 'Есть' && e.warrantyEnd && new Date(e.warrantyEnd) > new Date());
    if (status === 'problems') filtered = filtered.filter(e => e.hasProblems);
    if (manufacturer)          filtered = filtered.filter(e => e.manufacturerIds.includes(manufacturer));
    if (deviceName)            filtered = filtered.filter(e => e.deviceNameIds.includes(deviceName));
    if (city)                  filtered = filtered.filter(e => e.city?.toLowerCase().includes(city.toLowerCase()));
    if (company)               filtered = filtered.filter(e => String(e.companyId) === company || e.companyName?.toLowerCase().includes(company.toLowerCase()));

    const all = items;
    const stats = {
      total: all.length,
      mapped: all.filter(e => e.lat && e.lng).length,
      warranty: all.filter(e => e.hasWarranty === 'Есть' && e.warrantyEnd && new Date(e.warrantyEnd) > new Date()).length,
      problems: all.filter(e => e.hasProblems).length,
    };

    // Build manufacturer list for filter UI
    const mfrCounts = {};
    for (const item of all) {
      for (const id of item.manufacturerIds) {
        mfrCounts[id] = (mfrCounts[id] || 0) + 1;
      }
    }
    const manufacturers = Object.entries(MANUFACTURERS)
      .filter(([id]) => mfrCounts[id])
      .map(([id, name]) => ({ id, name, count: mfrCounts[id] }))
      .sort((a, b) => b.count - a.count);

    // Build device name list
    const devCounts = {};
    for (const item of all) {
      for (const id of item.deviceNameIds) {
        devCounts[id] = (devCounts[id] || 0) + 1;
      }
    }
    const deviceNames = Object.entries(deviceNamesCache)
      .filter(([id]) => devCounts[id])
      .map(([id, name]) => ({ id, name, count: devCounts[id] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100);

    // City list for autocomplete
    const cityCounts = {};
    for (const item of all) {
      if (item.city) cityCounts[item.city] = (cityCounts[item.city] || 0) + 1;
    }
    const cities = Object.entries(cityCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // Company list
    const companyMap = {};
    for (const item of all) {
      if (item.companyId && item.companyName) {
        companyMap[item.companyId] = item.companyName;
      }
    }
    const companies = Object.entries(companyMap)
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    res.json({
      ok: true, items: filtered, stats,
      manufacturers, deviceNames, cities, companies,
      cachedAt: new Date(cacheTs).toISOString(),
    });
  } catch(e) {
    console.error('equipment/map-data error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /equipment/refresh
router.post('/refresh', requireAuth(['admin','coordinator']), async (req, res) => {
  cache = null;
  res.json({ ok: true });
});

// DELETE geocode cache for failed items
router.post('/geocode-retry', requireAuth(['admin']), async (req, res) => {
  await pool.query('DELETE FROM ticketsmodule_equipment_geo WHERE geocode_failed=true').catch(() => {});
  cache = null;
  res.json({ ok: true });
});

module.exports = { router, setB24 };

const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const { fetchAllEquipment, fetchAndLinkTickets, fetchCompanyNames, geocodeEquipment } = require('../equipment-map');

let b24callFn = null;
function setB24(fn) { b24callFn = fn; }

let equipmentCache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 min

// GET /equipment/map-data
router.get('/map-data', requireAuth(), async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1';
    const now = Date.now();

    if (!equipmentCache || forceRefresh || (now - cacheTimestamp) > CACHE_TTL) {
      console.log('🔄 Loading equipment from Б24 1042...');

      // 1. Fetch all equipment from 1042
      let rawItems = [];
      try {
        rawItems = await fetchAllEquipment(b24callFn);
        console.log(`✅ Loaded ${rawItems.length} equipment items`);
      } catch(e) {
        console.error('fetchAllEquipment error:', e.message);
        return res.status(500).json({ ok: false, error: 'Ошибка загрузки оборудования из Б24: ' + e.message });
      }

      const equipmentMap = {};
      for (const item of rawItems) equipmentMap[item.id] = item;

      // 2. Link active service tickets
      try {
        await fetchAndLinkTickets(equipmentMap, b24callFn);
        console.log('✅ Tickets linked');
      } catch(e) {
        console.error('fetchAndLinkTickets error:', e.message);
        // Non-fatal — continue without tickets
      }

      // 3. Fetch company names
      try {
        const companyIds = [...new Set(rawItems.map(e => e.companyId).filter(Boolean))];
        const companyNames = await fetchCompanyNames(companyIds, b24callFn);
        for (const item of rawItems) {
          if (item.companyId) item.companyName = companyNames[item.companyId] || null;
        }
        console.log('✅ Company names loaded');
      } catch(e) {
        console.error('fetchCompanyNames error:', e.message);
        // Non-fatal
      }

      // 4. Geocode addresses
      try {
        const withCoords = await geocodeEquipment(rawItems, pool);
        equipmentCache = withCoords;
      } catch(e) {
        console.error('geocodeEquipment error:', e.message);
        equipmentCache = rawItems.map(i => ({ ...i, lat: null, lng: null }));
      }
      cacheTimestamp = now;
    }

    // Apply filter
    const { status } = req.query;
    let items = equipmentCache;
    if (status === 'prolab')    items = items.filter(e => e.seller === 'ProLabSupport');
    if (status === 'third')     items = items.filter(e => e.seller === 'Сторонний продавец');
    if (status === 'warranty')  items = items.filter(e => {
      return e.hasWarranty === 'Есть' && e.warrantyEnd && new Date(e.warrantyEnd) > new Date();
    });
    if (status === 'problems')  items = items.filter(e => e.hasProblems);

    const stats = {
      total: equipmentCache.length,
      mapped: equipmentCache.filter(e => e.lat && e.lng).length,
      warranty: equipmentCache.filter(e => e.hasWarranty === 'Есть' && e.warrantyEnd && new Date(e.warrantyEnd) > new Date()).length,
      problems: equipmentCache.filter(e => e.hasProblems).length,
    };

    res.json({ ok: true, items, stats, cachedAt: new Date(cacheTimestamp).toISOString() });
  } catch(e) {
    console.error('equipment/map-data error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /equipment/refresh — force cache refresh
router.post('/refresh', requireAuth(['admin','coordinator']), async (req, res) => {
  equipmentCache = null;
  res.json({ ok: true });
});

// POST /equipment/geocode-retry — retry failed geocodes
router.post('/geocode-retry', requireAuth(['admin']), async (req, res) => {
  await pool.query('DELETE FROM ticketsmodule_equipment_geo WHERE geocode_failed=true').catch(()=>{});
  equipmentCache = null;
  res.json({ ok: true });
});

module.exports = { router, setB24 };

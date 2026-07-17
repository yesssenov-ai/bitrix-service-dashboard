const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const fetch = require('node-fetch');
const companies = require('../gmk_companies.json');

// ── Geocode city cache in DB ──────────────────────────────────────────────────
const cityCache = {};

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_licenses_geo (
      city VARCHAR(200) PRIMARY KEY,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      geocoded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
}

async function geocodeCity(city) {
  if (!city) return null;
  const key = city.toLowerCase().trim();
  if (cityCache[key] !== undefined) return cityCache[key];

  // Check DB
  try {
    const r = await pool.query('SELECT lat, lng FROM ticketsmodule_licenses_geo WHERE LOWER(city)=$1', [key]);
    if (r.rows.length && r.rows[0].lat) {
      const coords = { lat: r.rows[0].lat, lng: r.rows[0].lng };
      cityCache[key] = coords;
      return coords;
    }
  } catch(e) {}

  // Geocode
  try {
    await new Promise(r => setTimeout(r, 1100));
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city + ', Казахстан')}&format=json&limit=1&countrycodes=kz`;
    const res = await fetch(url, { headers: { 'User-Agent': 'ProLabSupport-LicensesMap/1.0 (service@prolabsupport.kz)' } });
    const data = await res.json();
    if (data.length > 0) {
      const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
      cityCache[key] = coords;
      await pool.query(
        `INSERT INTO ticketsmodule_licenses_geo (city, lat, lng) VALUES ($1,$2,$3)
         ON CONFLICT (city) DO UPDATE SET lat=$2, lng=$3, geocoded_at=NOW()`,
        [key, coords.lat, coords.lng]
      ).catch(() => {});
      return coords;
    }
  } catch(e) {}
  cityCache[key] = null;
  return null;
}

// Pre-load city coords from DB on startup
async function preloadCityCache() {
  await ensureTable();
  try {
    const r = await pool.query('SELECT city, lat, lng FROM ticketsmodule_licenses_geo');
    for (const row of r.rows) {
      if (row.lat) cityCache[row.city] = { lat: row.lat, lng: row.lng };
    }
    console.log(`✅ Licenses geo cache: ${r.rows.length} cities`);
  } catch(e) {}
}
preloadCityCache();

// ── Product color map ────────────────────────────────────────────────────────
const PRODUCT_COLORS = {
  'Золото': '#FFD700', 'Медь': '#FF8C00', 'Уголь': '#4A4A4A',
  'Уран': '#7FFF00', 'Железо': '#8B4513', 'Фосфор': '#9370DB',
  'Серебро': '#C0C0C0', 'Свинец, цинк': '#708090', 'Марганец': '#FF69B4',
  'Хромиты': '#20B2AA', 'Полиметаллы': '#FF4500', 'Алюминий': '#87CEEB',
  'Барит': '#DEB887', 'Никель, кобальт': '#3CB371',
};

// ── GET /licenses/data ───────────────────────────────────────────────────────
router.get('/data', requireAuth(), async (req, res) => {
  try {
    const { area, product, search, bin } = req.query;

    let filtered = companies;
    if (area) filtered = filtered.filter(c => c.area?.trim() === area.trim());
    if (product) filtered = filtered.filter(c => c.product === product);
    if (bin) filtered = filtered.filter(c => c.bin === bin);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(c =>
        c.name?.toLowerCase().includes(q) ||
        c.bin?.includes(q) ||
        c.city?.toLowerCase().includes(q) ||
        c.ceo?.toLowerCase().includes(q)
      );
    }

    // Attach cached coords
    const items = filtered.slice(0, 500).map(c => {
      const key = c.city?.toLowerCase().trim();
      const coords = key ? cityCache[key] : null;
      return { ...c, lat: coords?.lat || null, lng: coords?.lng || null };
    });

    // Unique areas and products for filters
    const areas = [...new Set(companies.map(c => c.area?.trim()).filter(Boolean))].sort();
    const products = [...new Set(companies.map(c => c.product).filter(Boolean))].sort();

    const stats = {
      total: companies.length,
      withLicense: companies.filter(c => c.license).length,
      withCoords: Object.keys(cityCache).filter(k => cityCache[k]).length,
      products: products.length,
    };

    res.json({ ok: true, items, areas, products, stats, productColors: PRODUCT_COLORS });
  } catch(e) {
    console.error('licenses/data error:', e.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});

// ── POST /licenses/geocode — background geocode cities ───────────────────────
router.post('/geocode', requireAuth(['admin', 'coordinator']), async (req, res) => {
  // Get unique uncached cities
  const cities = [...new Set(companies.map(c => c.city).filter(Boolean))];
  const uncached = cities.filter(c => cityCache[c?.toLowerCase().trim()] === undefined);
  res.json({ ok: true, total: cities.length, toGeocode: uncached.length });

  // Geocode in background
  (async () => {
    let done = 0;
    for (const city of uncached) {
      await geocodeCity(city);
      done++;
      if (done % 10 === 0) console.log(`Geocoding licenses: ${done}/${uncached.length}`);
    }
    console.log(`✅ Licenses geocoding complete: ${done} cities`);
  })();
});

// ── GET /licenses/status ─────────────────────────────────────────────────────
router.get('/status', requireAuth(), (req, res) => {
  const total = [...new Set(companies.map(c => c.city).filter(Boolean))].length;
  const done = Object.keys(cityCache).filter(k => cityCache[k]).length;
  res.json({ ok: true, total, done, percent: Math.round(done / total * 100) });
});

module.exports = router;

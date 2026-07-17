const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const fetch = require('node-fetch');
let companies = [];
let companiesLoaded = false;

// Load async to avoid blocking server startup
(async () => {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    const data = await fs.readFile(path.join(__dirname, '../gmk_companies.json'), 'utf8');
    companies = JSON.parse(data);
    companiesLoaded = true;
    console.log(`✅ GMK companies loaded: ${companies.length}`);
  } catch(e) {
    console.error('Failed to load gmk_companies.json:', e.message);
  }
})();

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
  if (!companiesLoaded) {
    // Wait up to 5s for companies to load
    let waited = 0;
    while (!companiesLoaded && waited < 5000) {
      await new Promise(r => setTimeout(r, 200));
      waited += 200;
    }
    if (!companiesLoaded) return res.status(503).json({ ok: false, error: 'Данные ещё загружаются, попробуйте через секунду' });
  }
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


// ── GET /licenses/map-search — proxy to minerals.e-qazyna.kz contracts-map-search ──
router.get('/map-search', requireAuth(), async (req, res) => {
  try {
    const { search } = req.query;
    if (!search) return res.status(400).json({ ok: false, error: 'search param required' });

    const layers = [
      'ТПИ_Лицензия_Добыча','ТПИ_Лицензия_Разведка','ТПИ_Лицензия_Разведка_Отозван',
      'ТПИ_Контракт','ТПИ_Контракт_Горный','ТПИ_Контракт_Геологический',
      'ТПИ_Контракт_ГорныйГеологический','С_ТпиКонтрактНаРазведку',
      'С_ТпиКонтрактНаДобычу','С_ТпиКонтрактНаРазведкуИДобычу',
      'С_ТпиЛицензияНаДобычу','С_ТпиЛицензияНаРазведкуИДобычу','С_ТпиЛицензияНаРазведку',
    ];
    const params = new URLSearchParams();
    params.append('search', search);
    for (const l of layers) params.append('layers', l + ',');

    const resp = await fetch(
      `https://minerals.e-qazyna.kz/ru/contracts-map-search?${params.toString()}`,
      { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }
    );
    const text = await resp.text();
    console.log(`minerals map-search [${search}] status=${resp.status} body=${text.slice(0,200)}`);
    let data;
    try { data = JSON.parse(text); } catch(e) { data = text; }
    res.json({ ok: true, data, status: resp.status });
  } catch(e) {
    console.error('map-search proxy error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});


router.get('/resolve/:bin', requireAuth(), async (req, res) => {
  const { bin } = req.params;
  if (!bin || !/^\d{12}$/.test(bin)) return res.status(400).json({ ok: false, error: 'Неверный БИН' });

  try {
    // Fetch the license list page filtered by BIN
    const url = `https://minerals.e-qazyna.kz/ru/guest/reestr/license/list?bin=${bin}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
      timeout: 10000,
    });
    const html = await resp.text();

    // Extract license links: /ru/guest/reestr/contract/list/{ID}/View
    const matches = [...html.matchAll(/\/ru\/guest\/reestr\/contract\/list\/(\d+)\/View/g)];
    const ids = [...new Set(matches.map(m => m[1]))];

    if (!ids.length) {
      return res.json({ ok: true, licenses: [], message: 'Лицензии не найдены или БИН не совпадает' });
    }

    // Extract license numbers and types from table rows
    const licenseData = [];
    const rowRegex = /contract\/list\/(\d+)\/View[^<]*<\/a>\s*<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>([^<]+)<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>(\d+)/g;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      licenseData.push({
        id: match[1],
        number: match[2].trim(),
        date: match[3].trim(),
        url: `https://minerals.e-qazyna.kz/ru/guest/reestr/contract/list/${match[1]}/View`,
      });
    }

    // Fallback: just return IDs if regex didn't work
    const result = licenseData.length > 0 ? licenseData : ids.map(id => ({
      id,
      url: `https://minerals.e-qazyna.kz/ru/guest/reestr/contract/list/${id}/View`,
    }));

    res.json({ ok: true, licenses: result, bin });
  } catch(e) {
    console.error('resolve error:', e.message);
    res.status(500).json({ ok: false, error: 'Ошибка получения данных' });
  }
});


// ── GET /licenses/open — opens minerals.e-qazyna.kz with pre-filled search ──
router.get('/open', requireAuth(), (req, res) => {
  const { bin, num, type } = req.query;
  const searchValue = num || bin || '';
  const fieldType = num ? 'licenseNum' : 'bin';

  // Return an HTML page that opens minerals and auto-fills + submits the form
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Открываем лицензию…</title>
<style>
  body{font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f3f2f1;flex-direction:column;gap:14px;}
  .card{background:#fff;border-radius:12px;padding:28px 36px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.1);max-width:420px;}
  h3{font-size:16px;color:#201f1e;margin-bottom:8px;}
  p{font-size:13px;color:#605e5c;margin-bottom:18px;}
  .num{font-family:monospace;background:#f3f2f1;padding:4px 12px;border-radius:6px;font-size:14px;font-weight:700;color:#0f6cbd;}
  .spinner{width:28px;height:28px;border:3px solid #e1dfdd;border-top-color:#0f6cbd;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto;}
  @keyframes spin{to{transform:rotate(360deg);}}
  a{color:#0f6cbd;font-size:13px;}
</style>
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h3 style="margin-top:14px">Открываем на Minerals.gov.kz</h3>
  <p>Лицензия <span class="num">${searchValue}</span></p>
  <p style="font-size:12px;color:#8a8886">Если страница не открылась автоматически —<br>
  <a href="https://minerals.e-qazyna.kz/ru/guest/reestr/license/list" target="_blank">нажмите здесь</a></p>
</div>
<script>
  // Open minerals in new tab and auto-fill the search form
  const win = window.open('https://minerals.e-qazyna.kz/ru/guest/reestr/license/list', '_blank');
  
  // Store search params for the opened page to pick up
  // Since we can't control cross-origin window, use a fallback approach:
  // After 500ms try to interact with the opened window
  const searchVal = ${JSON.stringify(searchValue)};
  const fieldId = ${JSON.stringify(fieldType)};
  
  let attempts = 0;
  const tryFill = setInterval(() => {
    attempts++;
    try {
      if (win && win.document && win.document.readyState === 'complete') {
        // Try to find and fill the search field
        const inputs = win.document.querySelectorAll('input');
        let filled = false;
        inputs.forEach(inp => {
          const ph = inp.placeholder || '';
          if ((fieldId === 'licenseNum' && ph.includes('омер')) ||
              (fieldId === 'bin' && ph.includes('ИН'))) {
            inp.value = searchVal;
            inp.dispatchEvent(new Event('input', {bubbles:true}));
            inp.dispatchEvent(new Event('change', {bubbles:true}));
            filled = true;
          }
        });
        if (filled) {
          // Click search button
          setTimeout(() => {
            const btns = win.document.querySelectorAll('button');
            btns.forEach(b => { if (b.textContent.includes('оиск')) b.click(); });
          }, 300);
          clearInterval(tryFill);
        }
      }
    } catch(e) {
      // Cross-origin block — just close this page
      clearInterval(tryFill);
    }
    if (attempts > 20) clearInterval(tryFill);
  }, 200);
  
  // Close this helper page after 3 seconds
  setTimeout(() => window.close(), 3000);
</script>
</body>
</html>`);
});

module.exports = router;

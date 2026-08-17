const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const {
  fetchAllEquipment, fetchAndLinkTickets, fetchCompanyNames,
  geocodeEquipment, fetchDeviceNames, MANUFACTURERS,
} = require('../equipment-map');

let b24callFn = null;
function setB24(fn) { b24callFn = fn; }

// ── Состояние в памяти (наполняется из БД на старте — карта открывается сразу) ─
let cache = null;              // массив обогащённых приборов
let deviceNamesCache = {};
let meta = { lastFullSync: null, lastSync: null };
let isLoading = false;
let loadError = null;

// ── Таблицы кэша ──────────────────────────────────────────────────────────────
let _tablesReady = false;
async function ensureTables() {
  if (_tablesReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_equipment_cache (
    item_id INTEGER PRIMARY KEY, data JSONB, updated_time TIMESTAMPTZ, synced_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_equipment_meta (
    id INTEGER PRIMARY KEY, last_full_sync TIMESTAMPTZ, last_sync TIMESTAMPTZ, device_names JSONB)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_equipment_geo (
    item_id INTEGER PRIMARY KEY, address VARCHAR(300), lat DOUBLE PRECISION, lng DOUBLE PRECISION,
    geocode_failed BOOLEAN DEFAULT false, geocoded_at TIMESTAMPTZ DEFAULT NOW())`);
  _tablesReady = true;
}

// ── Персист ──────────────────────────────────────────────────────────────────
async function persistAll(items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE ticketsmodule_equipment_cache');
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      const vals = [], ph = [];
      chunk.forEach((it, k) => { const b = k * 3; ph.push(`($${b + 1},$${b + 2},$${b + 3})`); vals.push(it.id, JSON.stringify(it), it.updatedTime || null); });
      await client.query(`INSERT INTO ticketsmodule_equipment_cache (item_id, data, updated_time) VALUES ${ph.join(',')}
        ON CONFLICT (item_id) DO UPDATE SET data=EXCLUDED.data, updated_time=EXCLUDED.updated_time, synced_at=NOW()`, vals);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}
async function setMeta(fields) {
  await ensureTables();
  const cols = Object.keys(fields);
  const sets = cols.map((c, i) => `${c}=$${i + 2}`).join(',');
  await pool.query(
    `INSERT INTO ticketsmodule_equipment_meta (id, ${cols.join(',')}) VALUES (1, ${cols.map((_, i) => '$' + (i + 2)).join(',')})
     ON CONFLICT (id) DO UPDATE SET ${sets}`,
    [1, ...cols.map(c => fields[c])]
  );
}

// ── Загрузка из БД на старте (мгновенно) ─────────────────────────────────────
async function loadFromDb() {
  await ensureTables();
  try {
    const { rows } = await pool.query('SELECT data FROM ticketsmodule_equipment_cache');
    cache = rows.map(r => r.data);
    const m = await pool.query('SELECT last_full_sync, last_sync, device_names FROM ticketsmodule_equipment_meta WHERE id=1');
    if (m.rows.length) {
      meta.lastFullSync = m.rows[0].last_full_sync; meta.lastSync = m.rows[0].last_sync;
      deviceNamesCache = m.rows[0].device_names || {};
    }
    console.log(`✅ Equipment cache из БД: ${cache.length} приборов (last_sync ${meta.lastSync || '—'})`);
  } catch (e) { console.error('equipment loadFromDb error:', e.message); }
}

// ── Полная сборка (ночью / если БД пуста) ────────────────────────────────────
async function buildFull() {
  if (isLoading) return { skipped: true };
  isLoading = true; loadError = null;
  const t0 = Date.now();
  console.log('🔄 Equipment: полная сборка из Б24…');
  try {
    await ensureTables();
    const rawItems = await fetchAllEquipment(b24callFn);
    const map = {}; rawItems.forEach(it => { map[it.id] = it; });
    try { await fetchAndLinkTickets(map, b24callFn); } catch (e) { console.error('tickets:', e.message); }
    try {
      const ids = [...new Set(rawItems.map(e => e.companyId).filter(Boolean))];
      const names = await fetchCompanyNames(ids, b24callFn);
      rawItems.forEach(it => { if (it.companyId) it.companyName = names[it.companyId] || null; });
    } catch (e) { console.error('companies:', e.message); }
    try { deviceNamesCache = await fetchDeviceNames(b24callFn); } catch (e) {}
    let withCoords = rawItems;
    try { withCoords = await geocodeEquipment(rawItems, pool); } catch (e) { console.error('geocode:', e.message); }
    cache = withCoords;
    await persistAll(cache);
    const now = new Date();
    await setMeta({ last_full_sync: now, last_sync: now, device_names: JSON.stringify(deviceNamesCache) });
    meta.lastFullSync = now.toISOString(); meta.lastSync = now.toISOString();
    console.log(`✅ Equipment полная сборка: ${cache.length} приборов за ${Math.round((Date.now() - t0) / 1000)}с`);
    return { ok: true, count: cache.length };
  } catch (e) { loadError = e.message; console.error('buildFull error:', e.message); return { ok: false, error: e.message }; }
  finally { isLoading = false; }
}

// ── Инкрементальная подгрузка («Обновить» — только изменения) ─────────────────
async function buildIncremental() {
  if (isLoading) return { skipped: true, running: true };
  if (!cache || !cache.length || !meta.lastSync) return buildFull();
  isLoading = true; loadError = null;
  const t0 = Date.now();
  try {
    await ensureTables();
    const map = {}; cache.forEach(it => { map[it.id] = it; });
    // Изменённые приборы с прошлой синхронизации (буфер 10 мин на всякий случай).
    const since = new Date(new Date(meta.lastSync).getTime() - 10 * 60 * 1000).toISOString().slice(0, 19);
    const changed = await fetchAllEquipment(b24callFn, { '>updatedTime': since });
    // Пере-геокодируем те, у кого сменился город; мержим в карту.
    for (const it of changed) {
      const old = map[it.id];
      if (old && old.city !== it.city) { try { await pool.query('DELETE FROM ticketsmodule_equipment_geo WHERE item_id=$1', [it.id]); } catch (e) {} }
      else if (old) { it.lat = old.lat; it.lng = old.lng; } // город тот же — координаты сохраняем
      map[it.id] = it;
    }
    // Имена компаний для новых/изменённых.
    try {
      const ids = [...new Set(changed.map(e => e.companyId).filter(Boolean))];
      if (ids.length) { const names = await fetchCompanyNames(ids, b24callFn); changed.forEach(it => { if (it.companyId) map[it.id].companyName = names[it.companyId] || map[it.id].companyName || null; }); }
    } catch (e) { console.error('inc companies:', e.message); }
    // Геокодируем только изменённые (кэш по item_id — быстро для неизменных).
    try { const g = await geocodeEquipment(changed.map(c => map[c.id]), pool); g.forEach(x => { map[x.id] = x; }); } catch (e) { console.error('inc geocode:', e.message); }
    // Пере-привязываем активные заявки ко всему набору (открытых заявок немного).
    Object.values(map).forEach(it => { it.activeTickets = []; it.hasProblems = false; });
    try { await fetchAndLinkTickets(map, b24callFn); } catch (e) { console.error('inc tickets:', e.message); }
    cache = Object.values(map);
    await persistAll(cache);
    const now = new Date();
    await setMeta({ last_sync: now });
    meta.lastSync = now.toISOString();
    console.log(`✅ Equipment инкремент: изменено ${changed.length}, всего ${cache.length} за ${Math.round((Date.now() - t0) / 1000)}с`);
    return { ok: true, changed: changed.length, count: cache.length };
  } catch (e) { loadError = e.message; console.error('buildIncremental error:', e.message); return { ok: false, error: e.message }; }
  finally { isLoading = false; }
}

// ── Старт: поднять кэш из БД; если пусто — собрать в фоне ─────────────────────
async function bootPreload() {
  await loadFromDb();
  if (!cache || !cache.length) { console.log('Equipment cache пуст — запускаю полную сборку в фоне'); buildFull().catch(e => console.error('boot buildFull:', e.message)); }
}

// ── Ночная полная сборка (03:00 Алматы = 22:00 UTC) ──────────────────────────
function nightlyFullSync() { return buildFull(); }

// ── Ответ для карты (сборка ответа из кэша) ──────────────────────────────────
function buildResponse(query) {
  const all = cache || [];
  const { status, manufacturer, deviceName, city, company } = query;
  let filtered = all;
  if (status === 'prolab')   filtered = filtered.filter(e => e.seller === 'ProLabSupport');
  if (status === 'third')    filtered = filtered.filter(e => e.seller === 'Сторонний продавец');
  if (status === 'warranty') filtered = filtered.filter(e => e.hasWarranty === 'Есть' && e.warrantyEnd && new Date(e.warrantyEnd) > new Date());
  if (status === 'problems') filtered = filtered.filter(e => e.hasProblems);
  if (manufacturer)          filtered = filtered.filter(e => e.manufacturerIds.includes(manufacturer));
  if (deviceName)            filtered = filtered.filter(e => e.deviceNameIds.includes(deviceName));
  if (city)                  filtered = filtered.filter(e => e.city?.toLowerCase().includes(city.toLowerCase()));
  if (company)               filtered = filtered.filter(e => String(e.companyId) === company || e.companyName?.toLowerCase().includes(company.toLowerCase()));

  const stats = {
    total: all.length,
    mapped: all.filter(e => e.lat && e.lng).length,
    warranty: all.filter(e => e.hasWarranty === 'Есть' && e.warrantyEnd && new Date(e.warrantyEnd) > new Date()).length,
    problems: all.filter(e => e.hasProblems).length,
  };
  const mfrCounts = {}; all.forEach(it => it.manufacturerIds.forEach(id => { mfrCounts[id] = (mfrCounts[id] || 0) + 1; }));
  const manufacturers = Object.entries(MANUFACTURERS).filter(([id]) => mfrCounts[id]).map(([id, name]) => ({ id, name, count: mfrCounts[id] })).sort((a, b) => b.count - a.count);
  const devCounts = {}; all.forEach(it => it.deviceNameIds.forEach(id => { devCounts[id] = (devCounts[id] || 0) + 1; }));
  const deviceNames = Object.entries(deviceNamesCache).filter(([id]) => devCounts[id]).map(([id, name]) => ({ id, name, count: devCounts[id] })).sort((a, b) => b.count - a.count).slice(0, 100);
  const cityCounts = {}; all.forEach(it => { if (it.city) cityCounts[it.city] = (cityCounts[it.city] || 0) + 1; });
  const cities = Object.entries(cityCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  const companyMap = {}; all.forEach(it => { if (it.companyId && it.companyName) companyMap[it.companyId] = it.companyName; });
  const companies = Object.entries(companyMap).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  return { ok: true, items: filtered, stats, manufacturers, deviceNames, cities, companies, cachedAt: meta.lastSync, lastFullSync: meta.lastFullSync };
}

// GET /equipment/status
router.get('/status', requireAuth(), (req, res) => {
  res.json({ ok: true, isLoading, isReady: !!(cache && cache.length), error: loadError, count: cache?.length || 0, cachedAt: meta.lastSync, lastFullSync: meta.lastFullSync });
});

// GET /equipment/map-data — из кэша мгновенно; ?refresh=1 — инкрементальная подгрузка.
router.get('/map-data', requireAuth(), async (req, res) => {
  try {
    if (req.query.refresh === '1') { await buildIncremental(); }
    if ((!cache || !cache.length)) {
      if (isLoading) return res.json({ ok: true, loading: true, items: [], stats: { total: 0, mapped: 0, warranty: 0, problems: 0 }, manufacturers: [], deviceNames: [], cities: [], companies: [] });
      if (loadError) return res.status(500).json({ ok: false, error: loadError });
      buildFull().catch(() => {});
      return res.json({ ok: true, loading: true, items: [], stats: { total: 0, mapped: 0, warranty: 0, problems: 0 }, manufacturers: [], deviceNames: [], cities: [], companies: [] });
    }
    res.json(buildResponse(req.query));
  } catch (e) { console.error('equipment/map-data error:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

// POST /equipment/refresh — инкрементальное обновление (только изменения).
router.post('/refresh', requireAuth(['admin', 'coordinator']), async (req, res) => {
  const out = await buildIncremental();
  res.json({ ok: out.ok !== false, ...out });
});

// POST /equipment/full-refresh — принудительная полная пересборка (админ).
router.post('/full-refresh', requireAuth(['admin']), async (req, res) => {
  buildFull().catch(e => console.error('full-refresh:', e.message));
  res.json({ ok: true, started: true, note: 'Полная пересборка запущена в фоне' });
});

// POST /equipment/geocode-retry — сбросить неудачное геокодирование + полная пересборка.
router.post('/geocode-retry', requireAuth(['admin']), async (req, res) => {
  await pool.query('DELETE FROM ticketsmodule_equipment_geo WHERE geocode_failed=true').catch(() => {});
  buildFull().catch(e => console.error('geocode-retry:', e.message));
  res.json({ ok: true, started: true });
});

module.exports = { router, setB24, bootPreload, nightlyFullSync };

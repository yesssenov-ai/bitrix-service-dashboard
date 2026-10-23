// ── Мониторинг системы (Фаза 1) ─────────────────────────────────────────────
// Сбор live-метрик в процессе: ресурсы контейнера (cgroup), event-loop lag,
// пул БД, RED-метрики запросов (rate/errors/duration), онлайн-пользователи,
// здоровье внешних зависимостей (Bitrix / 1С / БД). Только для суперадминов.
// Накладные расходы минимальны: кольцевой буфер последних запросов в памяти.
const fs = require('fs');
const { monitorEventLoopDelay } = require('perf_hooks');

const eld = monitorEventLoopDelay({ resolution: 20 });
eld.enable();

// ── Кольцевой буфер запросов (последние 15 минут) ───────────────────────────
const REQ = [];
const REQ_WINDOW_MS = 15 * 60 * 1000;
function onRequestFinish(req, res, durationMs) {
  try {
    const now = Date.now();
    // Нормализуем путь, чтобы не плодить кардинальность: /admin/users/41 → /admin/users/:id
    let route = (req.baseUrl || '') + ((req.route && req.route.path) || req.path || '');
    route = route.replace(/\/\d+/g, '/:id').slice(0, 120) || '/';
    REQ.push({ ts: now, route: req.method + ' ' + route, status: res.statusCode || 0, duration: durationMs });
    const cut = now - REQ_WINDOW_MS;
    while (REQ.length && REQ[0].ts < cut) REQ.shift();
    if (req.user) touchUser(req.user, route, req.ip || (req.headers && req.headers['x-forwarded-for']) || '');
  } catch (e) { /* мониторинг не должен ломать запрос */ }
}

// ── Онлайн-пользователи (по последней активности) ───────────────────────────
const ONLINE = new Map(); // userId -> { id, name, role, lastSeen, lastRoute, ip }
function touchUser(u, route, ip) {
  if (!u || !u.id) return;
  ONLINE.set(u.id, { id: u.id, name: u.display_name || u.username || ('#' + u.id), role: u.role, lastSeen: Date.now(), lastRoute: route, ip: String(ip || '').split(',')[0].trim() });
}
const ONLINE_WINDOW_MS = 10 * 60 * 1000; // «онлайн» = активность за 10 минут
function onlineList() {
  const now = Date.now();
  const list = [...ONLINE.values()]
    .filter(u => u.lastSeen > now - 30 * 60 * 1000) // показываем последние 30 мин
    .map(u => ({ ...u, idleSec: Math.round((now - u.lastSeen) / 1000), online: u.lastSeen > now - ONLINE_WINDOW_MS }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  return list;
}

// ── Ресурсы контейнера (cgroup v2, с фолбэком на v1) ────────────────────────
function readIntFile(path) { try { const n = parseInt(String(fs.readFileSync(path, 'utf8')).trim(), 10); return isNaN(n) ? null : n; } catch (e) { return null; } }
function memInfo() {
  let used = readIntFile('/sys/fs/cgroup/memory.current');
  let limit = null;
  try { const s = String(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8')).trim(); limit = s === 'max' ? null : parseInt(s, 10); } catch (e) {}
  if (used == null) { // cgroup v1
    used = readIntFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
    const l = readIntFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (l != null && l < 9e18) limit = l;
  }
  const pct = (used != null && limit) ? Math.round(used / limit * 100) : null;
  return { usedMB: used != null ? Math.round(used / 1048576) : null, limitMB: limit ? Math.round(limit / 1048576) : null, pct };
}
let _lastCpu = null;
function cpuInfo() {
  let cores = null;
  try { const p = String(fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/); if (p[0] !== 'max') cores = parseInt(p[0], 10) / parseInt(p[1], 10); } catch (e) {}
  let usage = null;
  try { const m = String(fs.readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8')).match(/usage_usec\s+(\d+)/); if (m) usage = parseInt(m[1], 10); } catch (e) {}
  const now = Date.now();
  let pct = null;
  if (usage != null && _lastCpu) {
    const dUsage = usage - _lastCpu.usage;       // микросекунды CPU
    const dWall = (now - _lastCpu.t) * 1000;     // микросекунды реального времени
    if (dWall > 0) { const coresUsed = dUsage / dWall; pct = Math.max(0, Math.min(100, Math.round((cores ? coresUsed / cores : coresUsed) * 100))); }
  }
  if (usage != null) _lastCpu = { usage, t: now };
  return { cores: cores ? Math.round(cores * 100) / 100 : null, pct };
}

// ── Сводка live ─────────────────────────────────────────────────────────────
function pctOf(sorted, p) { if (!sorted.length) return null; const i = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length)); return Math.round(sorted[i]); }
function overview(pool) {
  const now = Date.now();
  const mem = memInfo();
  const cpu = cpuInfo();
  const pm = process.memoryUsage();
  const win = REQ.filter(r => r.ts > now - 60000);
  const durs = win.map(r => r.duration).sort((a, b) => a - b);
  const err5 = win.filter(r => r.status >= 500).length;
  const err4 = win.filter(r => r.status >= 400 && r.status < 500).length;
  const _m = eld.mean, _p = eld.percentile(99);
  const lagMean = isFinite(_m) ? Math.round(_m / 1e4) / 100 : 0;      // нс → мс
  const lagP99 = isFinite(_p) ? Math.round(_p / 1e4) / 100 : 0;
  try { eld.reset(); } catch (e) {}
  const online = [...ONLINE.values()].filter(u => u.lastSeen > now - ONLINE_WINDOW_MS).length;
  // Светофор состояния
  let status = 'ok';
  if ((mem.pct != null && mem.pct >= 90) || lagMean >= 200 || (pool && pool.waitingCount > 0) || err5 > 10) status = 'bad';
  else if ((mem.pct != null && mem.pct >= 80) || lagMean >= 80 || (cpu.pct != null && cpu.pct >= 85) || err5 > 0) status = 'warn';
  return {
    status,
    at: new Date(now).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    region: process.env.RAILWAY_REPLICA_REGION || process.env.RAILWAY_REGION || null,
    mem, cpu,
    heapUsedMB: Math.round(pm.heapUsed / 1048576),
    rssMB: Math.round(pm.rss / 1048576),
    eventLoopLagMs: lagMean, eventLoopP99Ms: lagP99,
    db: pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : null,
    rps: Math.round(win.length / 60 * 10) / 10,
    reqLastMin: win.length, err5LastMin: err5, err4LastMin: err4,
    errRatePct: win.length ? Math.round((err5 / win.length) * 1000) / 10 : 0,
    p50: pctOf(durs, 50), p95: pctOf(durs, 95), p99: pctOf(durs, 99),
    online,
  };
}

// ── Топы эндпоинтов (RED) за окно ───────────────────────────────────────────
function topEndpoints() {
  const agg = new Map();
  for (const r of REQ) {
    const e = agg.get(r.route) || { route: r.route, count: 0, errors: 0, durs: [] };
    e.count++; if (r.status >= 500) e.errors++; e.durs.push(r.duration); agg.set(r.route, e);
  }
  const rows = [...agg.values()].map(e => {
    const s = e.durs.sort((a, b) => a - b);
    return { route: e.route, count: e.count, errors: e.errors, p95: pctOf(s, 95), avg: Math.round(e.durs.reduce((a, b) => a + b, 0) / e.durs.length) };
  });
  return {
    byCount: [...rows].sort((a, b) => b.count - a.count).slice(0, 12),
    bySlow: [...rows].filter(r => r.count >= 2).sort((a, b) => (b.p95 || 0) - (a.p95 || 0)).slice(0, 8),
    byErrors: [...rows].filter(r => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 8),
    windowMin: Math.round(REQ_WINDOW_MS / 60000),
  };
}

// ── Здоровье зависимостей (кэш 25с, чтобы не долбить) ────────────────────────
let _depsCache = { at: 0, data: null };
async function timed(fn) { const t = Date.now(); try { await fn(); return { ok: true, ms: Date.now() - t }; } catch (e) { return { ok: false, ms: Date.now() - t, error: String(e && e.message || e).slice(0, 160) }; } }
async function deps(pool) {
  if (_depsCache.data && Date.now() - _depsCache.at < 25000) return _depsCache.data;
  const out = {};
  out.db = await timed(async () => { await pool.query('SELECT 1'); });
  try {
    const { b24 } = require('./bitrix');
    out.bitrix = await timed(async () => { const r = await b24('server.time', {}); if (!r || !r.result) throw new Error('нет ответа'); });
  } catch (e) { out.bitrix = { ok: false, ms: 0, error: 'не настроен' }; }
  try {
    const onec = require('./onec');
    if (onec.isConfigured && onec.isConfigured()) {
      out.onec = await timed(async () => { await onec.onec('health', {}, { timeoutMs: 8000 }); });
    } else out.onec = { ok: null, ms: 0, error: 'не настроена (моки)' };
  } catch (e) { out.onec = { ok: false, ms: 0, error: String(e && e.message || e).slice(0, 160) }; }
  _depsCache = { at: Date.now(), data: out };
  return out;
}

module.exports = { onRequestFinish, touchUser, onlineList, overview, topEndpoints, deps };

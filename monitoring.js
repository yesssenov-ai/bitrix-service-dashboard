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
  const now = Date.now();
  const prev = ONLINE.get(u.id);
  // Начало текущей сессии: если активность непрерывна (не отваливался больше окна) — сохраняем;
  // иначе это новая сессия — ставим текущий момент.
  const since = (prev && prev.since && (now - prev.lastSeen) <= ONLINE_WINDOW_MS) ? prev.since : now;
  ONLINE.set(u.id, { id: u.id, name: u.display_name || u.username || ('#' + u.id), role: u.role, since, lastSeen: now, lastRoute: route, ip: String(ip || '').split(',')[0].trim() });
}
const ONLINE_WINDOW_MS = 10 * 60 * 1000; // «онлайн» = активность за 10 минут
function onlineList() {
  const now = Date.now();
  const list = [...ONLINE.values()]
    .filter(u => u.lastSeen > now - 30 * 60 * 1000) // показываем последние 30 мин
    .map(u => ({ ...u, idleSec: Math.round((now - u.lastSeen) / 1000), sessionSec: Math.round((now - (u.since || u.lastSeen)) / 1000), sinceTs: u.since || u.lastSeen, online: u.lastSeen > now - ONLINE_WINDOW_MS }))
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

// ── Фаза 2: семплер метрик + история ────────────────────────────────────────
async function ensureMetricsTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_sys_metrics (
    ts timestamptz NOT NULL DEFAULT now(),
    mem_pct int, mem_used_mb int, cpu_pct int, lag_ms real,
    db_total int, db_waiting int, rps real, req_count int, err5 int, p95_ms int, online int
  )`);
  await pool.query(`ALTER TABLE ticketsmodule_sys_metrics ADD COLUMN IF NOT EXISTS db_size_mb int`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sys_metrics_ts ON ticketsmodule_sys_metrics (ts)`);
}
let _dbSizeMb = null, _dbSizeAt = 0;
async function dbSizeMb(pool) {
  if (_dbSizeMb != null && Date.now() - _dbSizeAt < 9 * 60000) return _dbSizeMb; // не чаще раза в ~10 мин
  try { const { rows } = await pool.query('SELECT pg_database_size(current_database()) AS b'); _dbSizeMb = Math.round(Number(rows[0].b) / 1048576); _dbSizeAt = Date.now(); } catch (e) {}
  return _dbSizeMb;
}
async function sampleOnce(pool) {
  try {
    const o = overview(pool);
    const sz = await dbSizeMb(pool);
    await pool.query(
      `INSERT INTO ticketsmodule_sys_metrics (mem_pct,mem_used_mb,cpu_pct,lag_ms,db_total,db_waiting,rps,req_count,err5,p95_ms,online,db_size_mb)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [o.mem.pct, o.mem.usedMB, o.cpu.pct, o.eventLoopLagMs, o.db && o.db.total, o.db && o.db.waiting, o.rps, o.reqLastMin, o.err5LastMin, o.p95, o.online, sz]
    );
    evalAlerts(pool, o).catch(() => {});
  } catch (e) { console.error('sys metrics sample:', e.message); }
}

// ── Фаза 3: прогноз/форкаст по трендам ──────────────────────────────────────
function linreg(pts) { const n = pts.length; if (n < 2) return null; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; } const d = n * sxx - sx * sx; if (!d) return null; const slope = (n * sxy - sx * sy) / d; return { slope, intercept: (sy - slope * sx) / n }; }
function fmtDaysRu(d) { if (d < 1) { const h = Math.max(1, Math.round(d * 24)); return h + ' ч'; } return Math.round(d) + ' дн'; }
function fmtMB(mb) { if (mb == null) return '—'; return mb >= 1024 ? (Math.round(mb / 1024 * 10) / 10) + ' ГБ' : Math.round(mb) + ' МБ'; }
async function forecast(pool) {
  let rows;
  try { ({ rows } = await pool.query(`SELECT extract(epoch from ts)/86400.0 AS x, mem_pct, cpu_pct, db_size_mb, db_waiting, lag_ms FROM ticketsmodule_sys_metrics WHERE ts > now() - interval '24 hours' ORDER BY ts`)); }
  catch (e) { return { ready: false, note: 'нет данных' }; }
  if (rows.length < 8) return { ready: false, note: 'данные накапливаются — прогноз появится, когда наберётся несколько часов истории', have: rows.length };
  const spanH = Math.round((rows[rows.length - 1].x - rows[0].x) * 24 * 10) / 10;
  const items = [];
  function toThreshold(key, title, threshold, unit) {
    const pts = rows.filter(r => r[key] != null).map(r => ({ x: r.x, y: Number(r[key]) }));
    if (pts.length < 8) return;
    const lr = linreg(pts); if (!lr) return;
    const cur = pts[pts.length - 1].y, perDay = lr.slope;
    let status = 'ok', text;
    if (cur >= threshold) { status = 'risk'; text = 'уже на пределе: ' + Math.round(cur) + unit; }
    else if (perDay > 0.1) {
      const days = (threshold - cur) / perDay;
      status = days < 3 ? 'risk' : days < 14 ? 'watch' : 'ok';
      text = 'сейчас ' + Math.round(cur) + unit + ', рост ~' + (perDay < 1 ? perDay.toFixed(2) : Math.round(perDay)) + unit + '/день → предел ' + threshold + unit + ' примерно через ' + fmtDaysRu(days);
    } else { text = 'стабильно (~' + Math.round(cur) + unit + '), заметного роста нет'; }
    items.push({ metric: key, title, status, text });
  }
  toThreshold('mem_pct', 'Память', 90, '%');
  toThreshold('cpu_pct', 'CPU', 90, '%');
  { const pts = rows.filter(r => r.db_size_mb != null).map(r => ({ x: r.x, y: Number(r.db_size_mb) }));
    if (pts.length >= 8) { const lr = linreg(pts); const cur = pts[pts.length - 1].y, perDay = lr ? Math.max(0, lr.slope) : 0;
      items.push({ metric: 'db_size', title: 'Размер БД', status: perDay > 50 ? 'watch' : 'ok', text: 'сейчас ' + fmtMB(cur) + ', рост ~' + fmtMB(perDay) + '/день' + (perDay > 0 ? ' (≈ ' + fmtMB(perDay * 30) + '/мес)' : '') + '. Лимит зависит от тарифа Supabase.' }); } }
  const maxWait = Math.max(0, ...rows.map(r => r.db_waiting || 0));
  items.push({ metric: 'db_pool', title: 'Пул соединений БД', status: maxWait > 0 ? 'watch' : 'ok', text: maxWait > 0 ? ('в пики очередь доходила до ' + maxWait + ' — пул близок к насыщению, пора думать о расширении') : 'очередей к пулу не было — запас есть' });
  const maxLag = Math.max(0, ...rows.map(r => r.lag_ms || 0));
  items.push({ metric: 'lag', title: 'Event-loop (подвисания)', status: maxLag >= 200 ? 'risk' : maxLag >= 80 ? 'watch' : 'ok', text: 'макс. задержка за сутки ' + Math.round(maxLag) + ' мс' + (maxLag >= 80 ? ' — были подвисания' : ' — стабильно') });
  return { ready: true, spanHours: spanH, points: rows.length, items };
}

// ── Фаза 3: пороговые алерты (Telegram управленцам, с антиспамом) ───────────
const _alertState = new Map(); // key -> { active, lastSent, label }
async function evalAlerts(pool, o) {
  const checks = [];
  if (o.mem && o.mem.pct != null) checks.push({ key: 'mem', label: 'память', bad: o.mem.pct >= 90, msg: 'память ' + o.mem.pct + '% (лимит ' + (o.mem.limitMB || '?') + ' МБ) — пора расширять ресурсы' });
  checks.push({ key: 'lag', label: 'event-loop', bad: o.eventLoopLagMs >= 200, msg: 'event-loop lag ' + o.eventLoopLagMs + ' мс — приложение подвисает' });
  checks.push({ key: 'err', label: 'ошибки 5xx', bad: o.err5LastMin > 10, msg: o.err5LastMin + ' ошибок 5xx за минуту' });
  if (o.db) checks.push({ key: 'dbpool', label: 'пул БД', bad: (o.db.waiting || 0) > 0, msg: 'очередь к пулу БД: ' + o.db.waiting + ' — соединения на пределе' });
  try {
    const d = await deps(pool);
    if (d.db) checks.push({ key: 'dep_db', label: 'БД', bad: d.db.ok === false, msg: 'база данных недоступна: ' + (d.db.error || '') });
    if (d.bitrix) checks.push({ key: 'dep_bitrix', label: 'Bitrix', bad: d.bitrix.ok === false, msg: 'Bitrix24 недоступен: ' + (d.bitrix.error || '') });
  } catch (e) {}
  const now = Date.now();
  const link = '\n🔗 ' + (process.env.DASH_URL || 'https://nms.prolabsupport.kz') + '/monitoring.html';
  let tg = null; try { tg = require('./notifications'); } catch (e) {}
  for (const c of checks) {
    const st = _alertState.get(c.key) || { active: false, lastSent: 0, label: c.label };
    if (c.bad) {
      if ((!st.active || now - st.lastSent > 30 * 60000) && tg) { tg.tgMgt('⚠️ <b>ЦУП мониторинг:</b> ' + c.msg + link).catch(() => {}); st.lastSent = now; }
      st.active = true;
    } else {
      if (st.active && tg) tg.tgMgt('✅ <b>ЦУП мониторинг:</b> норма — ' + c.label + link).catch(() => {});
      st.active = false;
    }
    st.label = c.label; _alertState.set(c.key, st);
  }
}
function activeAlerts() { return [..._alertState.entries()].filter(([, v]) => v.active).map(([k, v]) => ({ key: k, label: v.label })); }
const _histCache = {};
async function history(pool, range) {
  const is7d = range === '7d';
  const key = is7d ? '7d' : '24h';
  const c = _histCache[key];
  if (c && Date.now() - c.at < 55000) return c.data;   // кэш 55с — данные меняются раз в минуту
  const bucketSec = is7d ? 3600 : 300;           // 7д — по часу, 24ч — по 5 минут
  const interval = is7d ? '7 days' : '24 hours';
  const { rows } = await pool.query(
    `SELECT to_timestamp(floor(extract(epoch from ts)/$1)*$1) AS t,
       round(avg(mem_pct))::int AS mem_pct, round(avg(cpu_pct))::int AS cpu_pct,
       round(max(lag_ms)::numeric,1)::float AS lag_ms, round(avg(rps)::numeric,2)::float AS rps,
       max(p95_ms) AS p95_ms, round(avg(online))::int AS online, sum(err5)::int AS err5
     FROM ticketsmodule_sys_metrics
     WHERE ts > now() - $2::interval
     GROUP BY 1 ORDER BY 1`, [bucketSec, interval]);
  const data = { range: key, points: rows };
  _histCache[key] = { at: Date.now(), data };
  return data;
}
async function prune(pool) { try { await pool.query(`DELETE FROM ticketsmodule_sys_metrics WHERE ts < now() - interval '9 days'`); } catch (e) {} }
function startSampler(pool) {
  ensureMetricsTable(pool).then(() => {
    setTimeout(() => sampleOnce(pool), 15000);          // первый снимок через 15с после старта
    setInterval(() => sampleOnce(pool), 60000);         // далее раз в минуту
    setInterval(() => prune(pool), 6 * 3600 * 1000);    // чистка старше 9 дней
    console.log('Мониторинг: семплер метрик запущен (раз в минуту)');
  }).catch(e => console.error('sys metrics table:', e.message));
}

module.exports = { onRequestFinish, touchUser, onlineList, overview, topEndpoints, deps, history, startSampler, forecast, activeAlerts };

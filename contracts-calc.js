// Питает вкладку «Контракты» ЦУП. Всё считается из локального зеркала сделок
// (ticketsmodule_stat_deals — держится в актуальном состоянии stats-sync.js:
// вебхуки + ночная сверка), а НЕ живым сканом Bitrix на каждый запрос.
//   • donut «по услугам»       — сумма по воронке (Инструменты/Расходники/…)
//   • дерево «Детали контрактов»— сумма по стадиям, сгруппирована по семантике
//                                 (в работе / завершённые); имена стадий — живьём
//                                 из Bitrix (crm.status.list), чтобы совпадали с CRM
//   • помесячная / накопительная динамика — по дате договора
//   • «Выполнение плана»        — факт Bitrix по отделам vs план (наша таблица,
//                                 редактируется в UI; 1С добавим, когда подключим)
const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');

// ── Воронки (совпадает со stats/operational) ────────────────────────────────
const PIPELINES = {
  0: { name: 'Инструменты',  color: '#5b8cff' },
  1: { name: 'Расходники',   color: '#ffb020' },
  2: { name: 'Тренинг-центр',color: '#ff6b81' },
  3: { name: 'Сервис',       color: '#a56bff' },
};
// crm.status.list ENTITY_ID для стадий каждой воронки (STATUS_ID = наш stage_id).
const STAGE_ENTITIES = { 0: 'DEAL_STAGE', 1: 'DEAL_STAGE_1', 2: 'DEAL_STAGE_2', 3: 'DEAL_STAGE_3' };

// ── Отделы (совпадает со stats-calc / operational) ──────────────────────────
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'Spares', '4863': 'Service',
  '4864': 'Training', '4865': 'General Lab', '4866': 'Complex',
  '8384': 'Материаловедение',
};
// Хроматография и Клеточный анализ показываем одной строкой (как в отчётности).
function deptLabel(id) {
  const l = DEPARTMENT_LABELS[id] || id || 'Не указан';
  return (l === 'Хроматография' || l === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : l;
}
const DEPT_ORDER = ['Элементный', 'Хроматография и клеточный анализ', 'Электрохимия', 'Spares', 'Service', 'Training', 'General Lab', 'Complex', 'Материаловедение'];

// ── Живые имена/семантика ВСЕХ стадий сделок (кэш 1ч) ────────────────────────
// В отличие от operational.getPipelineStages (там режутся S/F) — тут нужны ВСЕ
// стадии, включая завершённые, чтобы построить дерево «в работе / завершённые».
let stageMetaCache = null, stageMetaAt = 0;
async function getAllStageMeta() {
  if (stageMetaCache && Date.now() - stageMetaAt < 3600 * 1000) return stageMetaCache;
  const byId = {};
  for (const [cat, entity] of Object.entries(STAGE_ENTITIES)) {
    try {
      const { result } = await b24('crm.status.list', {
        filter: { ENTITY_ID: entity },
        select: ['STATUS_ID', 'NAME', 'COLOR', 'SEMANTICS', 'SORT'],
      });
      (result || []).forEach(s => {
        byId[s.STATUS_ID] = {
          name: s.NAME || s.STATUS_ID,
          color: s.COLOR || '#8a8886',
          // SEMANTICS: 'S' успех, 'F' провал, иначе (null/'P') — в работе
          semantics: s.SEMANTICS === 'S' ? 'S' : s.SEMANTICS === 'F' ? 'F' : 'P',
          sort: parseInt(s.SORT, 10) || 0,
          category: parseInt(cat, 10),
        };
      });
    } catch (e) { console.error(`getAllStageMeta(${entity}) error:`, e.message); }
  }
  if (Object.keys(byId).length) { stageMetaCache = byId; stageMetaAt = Date.now(); }
  return stageMetaCache || byId;
}

// ── Загрузка сделок года из зеркала, с нормализацией валюты ──────────────────
async function loadDeals(year) {
  const rate = await getTodayRate();
  const { rows } = await pool.query(
    `SELECT deal_id, category_id, stage_id, opportunity, currency_id, department_id,
            assigned_by_id, contract_date
       FROM ticketsmodule_stat_deals
      WHERE contract_date BETWEEN $1 AND $2`,
    [`${year}-01-01`, `${year}-12-31`]
  );
  return rows.map(d => {
    const sum = parseFloat(d.opportunity) || 0;
    return {
      id: d.deal_id,
      category: d.category_id,
      stageId: d.stage_id,
      sumKzt: d.currency_id === 'USD' ? sum * rate : sum,
      dept: deptLabel(d.department_id),
      month: d.contract_date ? new Date(d.contract_date).getMonth() : null, // 0..11
    };
  });
}

// ── Таблица плана (заводим сами; редактируется из UI). ₸, ключ (год, отдел). ──
let planTableReady = false;
async function ensurePlanTable() {
  if (planTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_contract_plan (
      year INTEGER NOT NULL,
      department VARCHAR(80) NOT NULL,
      plan_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (year, department)
    )`);
  // Сид на 2026 из справочных цифр (млн ₸ → ₸). Только если год пустой —
  // чтобы не затирать ручные правки при каждом деплое.
  const { rows } = await pool.query(`SELECT 1 FROM ticketsmodule_contract_plan WHERE year=2026 LIMIT 1`);
  if (!rows.length) {
    const seed = {
      'Элементный': 3048, 'Хроматография и клеточный анализ': 2500, 'Электрохимия': 1100,
      'Spares': 1500, 'Service': 535, 'General Lab': 300,
    };
    for (const [dep, mln] of Object.entries(seed)) {
      await pool.query(
        `INSERT INTO ticketsmodule_contract_plan (year, department, plan_amount)
         VALUES ($1,$2,$3) ON CONFLICT (year, department) DO NOTHING`,
        [2026, dep, mln * 1e6]
      );
    }
  }
  planTableReady = true;
}
async function getPlan(year) {
  await ensurePlanTable();
  const { rows } = await pool.query(
    `SELECT department, plan_amount FROM ticketsmodule_contract_plan WHERE year=$1`, [year]
  );
  const map = {};
  rows.forEach(r => { map[r.department] = parseFloat(r.plan_amount) || 0; });
  return map;
}
async function setPlan(year, department, amount) {
  await ensurePlanTable();
  await pool.query(
    `INSERT INTO ticketsmodule_contract_plan (year, department, plan_amount)
     VALUES ($1,$2,$3)
     ON CONFLICT (year, department) DO UPDATE SET plan_amount=$3`,
    [year, department, Math.max(0, Number(amount) || 0)]
  );
}

// ── Главная сводка вкладки ──────────────────────────────────────────────────
async function getContractsSummary(year) {
  const [deals, stageMeta, planMap] = await Promise.all([loadDeals(year), getAllStageMeta(), getPlan(year)]);

  // KPI
  const totalKzt = deals.reduce((a, d) => a + d.sumKzt, 0);
  const dealCount = deals.length;
  const avgCheck = dealCount ? totalKzt / dealCount : 0;

  // Donut «по услугам» — по воронке
  const byPipe = {};
  for (const d of deals) {
    const p = PIPELINES[d.category] || { name: 'Прочее', color: '#8592ad' };
    (byPipe[p.name] = byPipe[p.name] || { name: p.name, color: p.color, sum: 0 }).sum += d.sumKzt;
  }
  const donut = Object.values(byPipe).sort((a, b) => b.sum - a.sum);

  // Дерево «Детали контрактов» — по стадиям, группировка по семантике
  const GROUPS = { P: { key: 'P', name: 'Сделки в работе', color: '#5b8cff' }, S: { key: 'S', name: 'Завершённые сделки', color: '#22c9a3' }, F: { key: 'F', name: 'Отменённые', color: '#ff5b6e' } };
  const stageAgg = {}; // stageId -> {name, sem, sum}
  for (const d of deals) {
    const m = stageMeta[d.stageId] || { name: d.stageId || 'Без стадии', semantics: 'P' };
    const k = d.stageId || '—';
    (stageAgg[k] = stageAgg[k] || { name: m.name, sem: m.semantics, sum: 0 }).sum += d.sumKzt;
  }
  const groupMap = { P: [], S: [], F: [] };
  Object.values(stageAgg).forEach(s => { (groupMap[s.sem] || groupMap.P).push({ name: s.name, sum: s.sum }); });
  const tree = ['P', 'S', 'F']
    .map(k => ({
      key: k, name: GROUPS[k].name, color: GROUPS[k].color,
      sum: groupMap[k].reduce((a, s) => a + s.sum, 0),
      kids: groupMap[k].sort((a, b) => b.sum - a.sum),
    }))
    .filter(g => g.kids.length);

  // Помесячная динамика (млн ₸ считает фронт) + накопительная
  const monthly = Array(12).fill(0);
  for (const d of deals) if (d.month != null) monthly[d.month] += d.sumKzt;
  const cumulative = [];
  monthly.reduce((run, v, i) => (cumulative[i] = run + v), 0);

  // Выполнение плана — факт по отделам
  const factByDept = {};
  for (const d of deals) factByDept[d.dept] = (factByDept[d.dept] || 0) + d.sumKzt;
  const depSet = new Set([...Object.keys(planMap), ...Object.keys(factByDept)]);
  const planRows = [...depSet]
    .map(dep => {
      const plan = planMap[dep] || 0, fact = factByDept[dep] || 0;
      return { dept, plan, fact, pct: plan ? +(fact / plan * 100).toFixed(1) : null };
    })
    .sort((a, b) => (DEPT_ORDER.indexOf(a.dept) + 1 || 99) - (DEPT_ORDER.indexOf(b.dept) + 1 || 99) || b.fact - a.fact);
  const planTotal = planRows.reduce((a, r) => a + r.plan, 0);
  const factTotal = planRows.reduce((a, r) => a + r.fact, 0);
  const planPct = planTotal ? +(factTotal / planTotal * 100).toFixed(1) : null;

  return {
    year, generatedAt: new Date().toISOString(),
    kpi: { totalKzt, dealCount, avgCheck, planPct, factTotal, planTotal },
    donut, tree, monthly, cumulative,
    plan: { rows: planRows, planTotal, factTotal, planPct },
  };
}

module.exports = { getContractsSummary, getPlan, setPlan, DEPT_ORDER };

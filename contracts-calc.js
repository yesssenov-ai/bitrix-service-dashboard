// Питает вкладку «Контракты» ЦУП. Отдаёт ПЛОСКИЙ список контрактных сделок из
// локального зеркала (ticketsmodule_stat_deals — вебхуки + ночная сверка), а все
// агрегаты (пирог, план/факт, дерево, динамика, KPI) считает фронт — чтобы клик
// по отделу мгновенно перефильтровывал все квадраты без похода на сервер.
//
// Что считается «контрактом» (фактом): сделка на контрактной стадии или позже
// (от стадии договора до завершения). До-контрактные стадии воронки (P10–P80 и
// прочая квалификация) СЮДА НЕ ПОПАДАЮТ. Группировка отдела повторяет модуль
// Статистики: если поле «Отдел» пустое — берём короткое имя воронки (ОРМ/Service/…),
// иначе сделки воронки «Сервис» с пустым отделом терялись бы (было 155 вместо 229).
const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');

// ── Воронки ─────────────────────────────────────────────────────────────────
const PIPE_META = {
  0: { name: 'Инструменты',   short: 'Inst',    color: '#5b8cff' },
  1: { name: 'ОРМ',           short: 'ОРМ',     color: '#ffb020' },
  2: { name: 'Тренинг-центр', short: 'Training',color: '#3ddc97' },
  3: { name: 'Сервис',        short: 'Service', color: '#ff6b81' },
};
const STAGE_ENTITIES = { 0: 'DEAL_STAGE', 1: 'DEAL_STAGE_1', 2: 'DEAL_STAGE_2', 3: 'DEAL_STAGE_3' };

// Контрактные стадии (от договора до завершения) — совпадает с completedStages
// модуля Статистики. Всё, чего тут нет (до-контрактная воронка) — не «факт».
const CONTRACT_STAGES = {
  0: ['FINAL_INVOICE', '1', 'UC_Q9J6VV', 'UC_9MBFR2', '2', '3', 'WON'],
  1: ['C1:FINAL_INVOICE', 'C1:1', 'C1:UC_3MVK90', 'C1:UC_3SCB5K', 'C1:2', 'C1:3', 'C1:WON'],
  2: ['C2:FINAL_INVOICE', 'C2:1', 'C2:2', 'C2:WON'],
  3: ['C3:FINAL_INVOICE', 'C3:UC_YYTFYG', 'C3:2', 'C3:WON'],
};
const CONTRACT_SET = Object.values(CONTRACT_STAGES).flat();
// Стадия «Контракт» (первая контрактная) и «Завершена» по воронкам — для Новостей.
const CONTRACT_STAGE = { 0: 'FINAL_INVOICE', 1: 'C1:FINAL_INVOICE', 2: 'C2:FINAL_INVOICE', 3: 'C3:FINAL_INVOICE' };
const WON_STAGE = { 0: 'WON', 1: 'C1:WON', 2: 'C2:WON', 3: 'C3:WON' };

// ── Отделы ──────────────────────────────────────────────────────────────────
const DEPARTMENT_LABELS = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'ОРМ', '4863': 'Service',
  '4864': 'Training', '4865': 'General Lab', '4866': 'Complex',
  '8384': 'Материаловедение',
};
const DEPT_ORDER = ['Элементный', 'Хроматография и клеточный анализ', 'Электрохимия', 'ОРМ', 'Service', 'Training', 'General Lab', 'Complex', 'Материаловедение'];
// saleType: как в stats-calc — отдел (Хроматография+Клеточный слиты), иначе воронка.
function saleType(category, deptId) {
  const dep = DEPARTMENT_LABELS[deptId];
  const merged = (dep === 'Хроматография' || dep === 'Клеточный анализ') ? 'Хроматография и клеточный анализ' : dep;
  return merged || (PIPE_META[category] && PIPE_META[category].short) || 'Прочее';
}

// ── Живые имена/семантика всех стадий сделок (кэш 1ч) ────────────────────────
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
          name: s.NAME || s.STATUS_ID, color: s.COLOR || '#8a8886',
          semantics: s.SEMANTICS === 'S' ? 'S' : s.SEMANTICS === 'F' ? 'F' : 'P',
          sort: parseInt(s.SORT, 10) || 0, category: parseInt(cat, 10),
        };
      });
    } catch (e) { console.error(`getAllStageMeta(${entity}) error:`, e.message); }
  }
  if (Object.keys(byId).length) { stageMetaCache = byId; stageMetaAt = Date.now(); }
  return stageMetaCache || byId;
}

// База ссылки на сделку в Bitrix (из вебхука).
function dealUrlBase() {
  try { return new URL(process.env.BITRIX_WEBHOOK).origin + '/crm/deal/details/'; }
  catch (e) { return null; }
}

// ── Плоский список контрактных сделок года ──────────────────────────────────
async function loadDeals(year) {
  const [rate, stageMeta] = await Promise.all([getTodayRate(), getAllStageMeta()]);
  const { rows } = await pool.query(
    `SELECT deal_id, category_id, stage_id, deal_title, opportunity, currency_id,
            department_id, company_id, contract_date, manufacturer
       FROM ticketsmodule_stat_deals
      WHERE contract_date BETWEEN $1 AND $2 AND stage_id = ANY($3)`,
    [`${year}-01-01`, `${year}-12-31`, CONTRACT_SET]
  );
  const base = dealUrlBase();
  return rows.map(d => {
    const sum = parseFloat(d.opportunity) || 0;
    const m = stageMeta[d.stage_id] || { name: d.stage_id || 'Без стадии', semantics: 'P', sort: 9999 };
    const pipe = PIPE_META[d.category_id] || { name: 'Прочее', color: '#8592ad' };
    return {
      id: d.deal_id,
      title: d.deal_title || null,
      category: d.category_id,
      pipeName: pipe.name,
      saleType: saleType(d.category_id, d.department_id),
      manufacturer: d.manufacturer || null,
      stageId: d.stage_id,
      stageName: m.name,
      stageSort: m.sort != null ? m.sort : 9999,
      sem: m.semantics,
      sumKzt: d.currency_id === 'USD' ? sum * rate : sum,
      currency: d.currency_id,
      month: d.contract_date ? new Date(d.contract_date).getMonth() : null,
      date: d.contract_date ? new Date(d.contract_date).toISOString().slice(0, 10) : null,
      url: base ? base + d.deal_id + '/' : null,
    };
  });
}

// ── Таблица плана (₸, ключ год+отдел) + миграция Spares→ОРМ ──────────────────
let planTableReady = false;
async function ensurePlanTable() {
  if (planTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ticketsmodule_contract_plan (
      year INTEGER NOT NULL, department VARCHAR(80) NOT NULL,
      plan_amount NUMERIC(18,2) NOT NULL DEFAULT 0, PRIMARY KEY (year, department)
    )`);
  // Переименование старого сида (если модуль уже деплоился с 'Spares').
  await pool.query(`UPDATE ticketsmodule_contract_plan SET department='ОРМ' WHERE department='Spares'
                     AND NOT EXISTS (SELECT 1 FROM ticketsmodule_contract_plan p2 WHERE p2.year=ticketsmodule_contract_plan.year AND p2.department='ОРМ')`);
  const { rows } = await pool.query(`SELECT 1 FROM ticketsmodule_contract_plan WHERE year=2026 LIMIT 1`);
  if (!rows.length) {
    const seed = { 'Элементный': 3048, 'Хроматография и клеточный анализ': 2500, 'Электрохимия': 1100, 'ОРМ': 1500, 'Service': 535, 'General Lab': 300 };
    for (const [dep, mln] of Object.entries(seed)) {
      await pool.query(`INSERT INTO ticketsmodule_contract_plan (year, department, plan_amount) VALUES ($1,$2,$3) ON CONFLICT (year, department) DO NOTHING`, [2026, dep, mln * 1e6]);
    }
  }
  planTableReady = true;
}
async function getPlan(year) {
  await ensurePlanTable();
  const { rows } = await pool.query(`SELECT department, plan_amount FROM ticketsmodule_contract_plan WHERE year=$1`, [year]);
  const map = {};
  rows.forEach(r => { map[r.department] = parseFloat(r.plan_amount) || 0; });
  return map;
}
async function setPlan(year, department, amount) {
  await ensurePlanTable();
  await pool.query(
    `INSERT INTO ticketsmodule_contract_plan (year, department, plan_amount) VALUES ($1,$2,$3)
     ON CONFLICT (year, department) DO UPDATE SET plan_amount=$3`,
    [year, department, Math.max(0, Number(amount) || 0)]
  );
}

// ── Когда зеркало последний раз обновлялось ─────────────────────────────────
async function getLastSync() {
  try {
    const { rows } = await pool.query(`SELECT MAX(synced_at) AS t FROM ticketsmodule_stat_deals`);
    return rows[0] && rows[0].t ? new Date(rows[0].t).toISOString() : null;
  } catch (e) { return null; }
}

// ── Сводка вкладки ──────────────────────────────────────────────────────────
async function getContractsSummary(year) {
  const [deals, planMap, updatedAt] = await Promise.all([loadDeals(year), getPlan(year), getLastSync()]);
  return {
    year, generatedAt: new Date().toISOString(), updatedAt,
    deals, planMap, deptOrder: DEPT_ORDER,
    pipelines: Object.fromEntries(Object.entries(PIPE_META).map(([k, v]) => [k, { name: v.name, color: v.color }])),
  };
}

// ── Новости: сделки, зашедшие в «Контракт»/«Завершена» за последние 3 дня ────
// Живой запрос в Bitrix (MOVED_TIME — время последнего перехода по стадии),
// кэш 10 мин. Ссылки — на карточку сделки.
let newsCache = null, newsAt = 0;
async function getRecentNews(days = 3) {
  if (newsCache && Date.now() - newsAt < 10 * 60 * 1000) return newsCache;
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const [stageMeta, rate] = await Promise.all([getAllStageMeta(), getTodayRate()]);
  const base = dealUrlBase();
  const out = [];
  for (const cat of [0, 1, 2, 3]) {
    const stages = [CONTRACT_STAGE[cat], WON_STAGE[cat]];
    try {
      let start = 0;
      while (true) {
        const { result, next } = await b24('crm.deal.list', {
          filter: { CATEGORY_ID: String(cat), STAGE_ID: stages, '>=MOVED_TIME': since },
          select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'MOVED_TIME', 'DATE_MODIFY', 'ASSIGNED_BY_ID'],
          order: { MOVED_TIME: 'DESC' }, start,
        });
        (result || []).forEach(d => {
          const m = stageMeta[d.STAGE_ID] || { name: d.STAGE_ID, semantics: 'P' };
          const sum = parseFloat(d.OPPORTUNITY) || 0;
          out.push({
            id: d.ID, title: d.TITLE || ('Сделка #' + d.ID),
            stageName: m.name, sem: d.STAGE_ID === WON_STAGE[cat] ? 'S' : 'P',
            kind: d.STAGE_ID === WON_STAGE[cat] ? 'Завершена' : 'Контракт',
            sumKzt: d.CURRENCY_ID === 'USD' ? sum * rate : sum,
            at: d.MOVED_TIME || d.DATE_MODIFY || null,
            url: base ? base + d.ID + '/' : null,
          });
        });
        if (next === undefined || next === null) break;
        start = next;
      }
    } catch (e) { console.error(`getRecentNews(cat ${cat}) error:`, e.message); }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  newsCache = out.slice(0, 40); newsAt = Date.now();
  return newsCache;
}

module.exports = { getContractsSummary, getPlan, setPlan, getRecentNews, DEPT_ORDER };

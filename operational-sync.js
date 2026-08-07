// ─────────────────────────────────────────────────────────────────────────────
// Operational cache sync — keeps ticketsmodule_operational_deals fresh.
//
// Three refresh paths (same idea as the Статистика module):
//   • syncOneDeal(id)  — called from the ONCRMDEALADD/UPDATE webhook (live)
//   • fullSync()       — nightly reconciliation + one-shot on boot + the
//                        manual "Обновить" button; re-pulls every execution
//                        deal and prunes anything that left the scope
//   • runAutomationSweep() — recomputes per-deal child-process/task counts
//
// The board then reads straight from Postgres (see operational.getBoard), so a
// dashboard open costs one SQL query and zero Bitrix calls.
// ─────────────────────────────────────────────────────────────────────────────
const { b24 } = require('./bitrix');
const { pool } = require('./auth');
const {
  F, PIPELINES, ENUM_FIELDS, PAY_SUPPLIER_LABELS, CLIENT_PAY_LABELS,
  getPipelineStages, buildEnumMap, resolveCompanies, fetchDeals,
  getClientPayMap, getBizprocTemplates, getActiveBizproc, matchActiveBp, invalidateDealDetail,
  getBizprocTasksByWorkflow,
} = require('./operational');
const { findChildrenOfDeal, resolveStageName } = require('./relations');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const firstOf = v => Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
const dateOnly = v => v ? String(v).slice(0, 10) : null;
const truthyBool = v => { const s = String(firstOf(v)); return s === '1' || s === 'Y' || s === 'true'; };

// ── Fields sourced from CHILD smart processes (not the deal itself) ──────────
// Закупки (1066): дата отгрузки от завода + условия оплаты (УС, iblock 21 → 83-86).
const PURCHASE_FIELDS = {
  factoryShip: 'ufCrm10_1732858508586', // Дата отгрузки от завода
  payClient:   'ufCrm10_1732858644',    // Условия оплаты для клиента (УС)
  payFactory:  'ufCrm10_1746431292',    // Условия оплаты поставщикам (УС)
};
// Заявка на сервис (1058): ответственный инженер. Берём с той 1058, что создана
// из «Запланированных работ» (parentId1050). Не назначен → пусто.
const SERVICE_ENGINEER_FIELD = 'ufCrm8_1732856367';

// Pull the child-sourced fields for one deal (uses the already-fetched children).
async function computeEnrichment(dealId, children) {
  const out = { factory_ship_date: null, pay_client: '', pay_factory: '', engineer_id: null };
  const purchase = children.find(c => Number(c.entityTypeId) === 1066);
  if (purchase) {
    try {
      const { result } = await b24('crm.item.get', { entityTypeId: 1066, id: purchase.id });
      const it = result?.item || {};
      out.factory_ship_date = dateOnly(it[PURCHASE_FIELDS.factoryShip]);
      const pc = firstOf(it[PURCHASE_FIELDS.payClient]);
      const pf = firstOf(it[PURCHASE_FIELDS.payFactory]);
      out.pay_client = (pc != null && pc !== '') ? (CLIENT_PAY_LABELS[String(pc)] || String(pc)) : '';
      out.pay_factory = (pf != null && pf !== '') ? (CLIENT_PAY_LABELS[String(pf)] || String(pf)) : '';
    } catch (e) { console.error(`enrichment 1066 (deal ${dealId}):`, e.message); }
  }
  const planned = children.find(c => Number(c.entityTypeId) === 1050);
  if (planned) {
    try {
      const { result } = await b24('crm.item.list', { entityTypeId: 1058, filter: { parentId1050: planned.id }, select: ['id', SERVICE_ENGINEER_FIELD] });
      for (const it of (result?.items || [])) { const eng = firstOf(it[SERVICE_ENGINEER_FIELD]); if (eng) { out.engineer_id = parseInt(eng, 10); break; } }
    } catch (e) { console.error(`enrichment 1058 (deal ${dealId}):`, e.message); }
  }
  return out;
}

// ── Build the deal-level DB record from a raw Bitrix deal ────────────────────
async function buildDealRecord(d, ctx) {
  const categoryId = Number(d.__categoryId ?? d.CATEGORY_ID);
  const stageMeta = ctx.stageMeta[categoryId] || await getPipelineStages(categoryId);
  const semantic = stageMeta.byId?.[d.STAGE_ID]?.semantics || 'P';
  return {
    deal_id: parseInt(d.ID, 10),
    category_id: categoryId,
    stage_id: d.STAGE_ID,
    stage_semantic: semantic,
    opportunity: parseFloat(d.OPPORTUNITY) || 0,
    currency_id: d.CURRENCY_ID || 'KZT',
    assigned_by_id: d.ASSIGNED_BY_ID ? parseInt(d.ASSIGNED_BY_ID, 10) : null,
    department_id: firstOf(d[F.department]) || null,
    deal_title: d.TITLE || '',
    company_id: d.COMPANY_ID ? parseInt(d.COMPANY_ID, 10) : null,
    company_name: d.COMPANY_ID ? (ctx.companyMap[String(d.COMPANY_ID)] || '') : '',
    contract_no: firstOf(d[F.contractNo]) || '',
    contract_date: dateOnly(d[F.contractDate]),
    delivery_by_date: dateOnly(d[F.deliveryByDate]), // "Срок поставки заказа по договору"
    comment: firstOf(d[F.comment]) || '',
    red_flag: truthyBool(d[F.redFlag]),
    date_modify: d.DATE_MODIFY || null,
  };
}

// Upsert deal-level columns only. Child-sourced fields (factory_ship_date,
// pay_client, pay_factory, engineer_id) and automation counts are written
// separately by updateAutomation, so a fast deal-level sync doesn't wipe them.
async function upsertDealLevel(r) {
  await pool.query(
    `INSERT INTO ticketsmodule_operational_deals
      (deal_id, category_id, stage_id, stage_semantic, opportunity, currency_id, assigned_by_id, department_id,
       deal_title, company_id, company_name, contract_no, contract_date, delivery_by_date, comment, red_flag, date_modify, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (deal_id) DO UPDATE SET
       category_id=$2, stage_id=$3, stage_semantic=$4, opportunity=$5, currency_id=$6, assigned_by_id=$7, department_id=$8,
       deal_title=$9, company_id=$10, company_name=$11, contract_no=$12, contract_date=$13, delivery_by_date=$14,
       comment=$15, red_flag=$16, date_modify=$17, synced_at=NOW()`,
    [r.deal_id, r.category_id, r.stage_id, r.stage_semantic, r.opportunity, r.currency_id, r.assigned_by_id, r.department_id,
     r.deal_title, r.company_id, r.company_name, r.contract_no, r.contract_date, r.delivery_by_date, r.comment, r.red_flag, r.date_modify]
  );
}

// Writes automation counts + the child-sourced enrichment fields.
async function updateAutomation(dealId, a) {
  const e = a.enrichment || {};
  const bpCols = a.openBp === undefined ? '' : ', open_bp=$9';
  const params = [dealId, a.open, a.overdue, a.total,
    e.factory_ship_date || null, e.pay_client || '', e.pay_factory || '', e.engineer_id || null];
  if (a.openBp !== undefined) params.push(a.openBp);
  await pool.query(
    `UPDATE ticketsmodule_operational_deals
       SET open_processes=$2, overdue_tasks=$3, total_tasks=$4,
           factory_ship_date=$5, pay_client=$6, pay_factory=$7, engineer_id=$8${bpCols}
     WHERE deal_id=$1`,
    params
  );
}

// ── Per-deal automation snapshot: open child processes + overdue tasks + БП ───
// Pass bp={instances, tpl} to also count active business processes on the deal
// and its smart children; omit it (webhook path) to leave open_bp untouched.
async function computeAutomation(dealId, bp) {
  let open = 0, openBp;
  let children = [];
  try {
    children = await findChildrenOfDeal(dealId);
    for (const c of children) {
      // findChildrenOfDeal doesn't select categoryId — recover it from the
      // stage code prefix ("DT1058_11:SUCCESS" → category 11) so the stage
      // semantics resolve; otherwise every child defaulted to open ('P').
      const m = String(c.stageId).match(/^DT\d+_(\d+):/);
      const catId = c.categoryId ?? (m ? m[1] : null);
      let sem = 'P';
      try { sem = (await resolveStageName(c.entityTypeId, catId, c.stageId)).semantics || 'P'; } catch (e) { /* keep P */ }
      if (sem === 'P') open++;
    }
  } catch (e) { console.error(`computeAutomation children (deal ${dealId}):`, e.message); }

  let total = 0, overdue = 0;
  try {
    const { result } = await b24('tasks.task.list', {
      filter: { UF_CRM_TASK: `D_${dealId}` },
      select: ['ID', 'STATUS', 'DEADLINE'],
    });
    const tasks = result?.tasks || result || [];
    const now = Date.now();
    for (const t of tasks) {
      total++;
      const status = parseInt(t.status ?? t.STATUS, 10);
      const deadline = t.deadline ?? t.DEADLINE;
      if (status !== 5 && deadline && new Date(deadline).getTime() < now) overdue++;
    }
  } catch (e) { console.error(`computeAutomation tasks (deal ${dealId}):`, e.message); }

  if (bp && bp.instances) {
    const matched = matchActiveBp(bp.instances, dealId, children, bp.tpl);
    // Count only BPs that WAIT ON A HUMAN (have a pending bizproc task) — perpetual
    // auto-BPs (e.g. template 85 on Регистрация контрактов, 451 always-active
    // instances) don't require action and would otherwise flag almost every deal.
    openBp = bp.taskMap
      ? matched.filter(m => (bp.taskMap[String(m.id)] || []).length > 0).length
      : matched.length;
  }

  const enrichment = await computeEnrichment(dealId, children);
  return { open, overdue, total, openBp, enrichment };
}

// ── Webhook path: sync exactly one deal (or drop it if it left the scope) ────
async function syncOneDeal(dealId) {
  const { result } = await b24('crm.deal.get', { id: dealId });
  if (!result) return;
  const d = result;
  const categoryId = Number(d.CATEGORY_ID);
  const cfg = PIPELINES[categoryId];
  const inScope = cfg && cfg.stages.includes(d.STAGE_ID);
  if (!inScope) {
    await pool.query('DELETE FROM ticketsmodule_operational_deals WHERE deal_id=$1', [dealId]).catch(() => {});
    await invalidateDealDetail(dealId);
    return;
  }
  const stageMeta = { [categoryId]: await getPipelineStages(categoryId) };
  const enumMaps = {};
  for (const code of ENUM_FIELDS) enumMaps[code] = await buildEnumMap(code);
  const companyMap = await resolveCompanies([d.COMPANY_ID]);
  const clientPayMap = await getClientPayMap();
  const rec = await buildDealRecord({ ...d, __categoryId: categoryId }, { stageMeta, enumMaps, companyMap, clientPayMap });
  await upsertDealLevel(rec);
  // Webhook path: recompute processes/tasks (cheap); leave open_bp to the
  // fuller nightly/manual sync so we don't pull all BP instances per event.
  try { await updateAutomation(dealId, await computeAutomation(dealId)); } catch (e) { /* best-effort */ }
  // Deal changed → drop its cached drill-down so the next open rebuilds fresh.
  await invalidateDealDetail(dealId);
}

// ── Full reconciliation (nightly / boot / manual button) ─────────────────────
let syncing = false;
async function fullSync(opts = {}) {
  if (syncing) { console.log('operational fullSync: already running, skipped'); return { skipped: true }; }
  syncing = true;
  const source = opts.source || 'nightly';
  const withAutomation = opts.withAutomation !== false;
  const startedAt = Date.now();
  try {
    const cats = Object.keys(PIPELINES).map(Number);
    const stageMeta = {};
    for (const c of cats) stageMeta[c] = await getPipelineStages(c);
    const enumMaps = {};
    for (const code of ENUM_FIELDS) enumMaps[code] = await buildEnumMap(code);

    const allDeals = await fetchDeals({ categoryIds: cats }); // execution stages only
    const companyMap = await resolveCompanies(allDeals.map(d => d.COMPANY_ID));
    const clientPayMap = await getClientPayMap();
    const ctx = { stageMeta, enumMaps, companyMap, clientPayMap };

    const seen = [];
    for (const d of allDeals) {
      try {
        const rec = await buildDealRecord(d, ctx);
        await upsertDealLevel(rec);
        seen.push(rec.deal_id);
      } catch (e) { console.error(`fullSync upsert (deal ${d.ID}):`, e.message); }
    }

    // Prune deals that are no longer in the execution scope (moved back, lost, deleted).
    if (seen.length) {
      await pool.query('DELETE FROM ticketsmodule_operational_deals WHERE deal_id <> ALL($1::int[])', [seen]).catch(e => console.error('prune:', e.message));
    } else {
      await pool.query('DELETE FROM ticketsmodule_operational_deals').catch(() => {});
    }

    if (withAutomation) {
      // Prefetch bizproc templates + all active instances once, then match per deal.
      let bp = null;
      try { bp = { tpl: await getBizprocTemplates(), instances: await getActiveBizproc(true), taskMap: await getBizprocTasksByWorkflow() }; }
      catch (e) { console.error('bizproc prefetch:', e.message); }
      for (const id of seen) {
        try { await updateAutomation(id, await computeAutomation(id, bp)); } catch (e) { /* best-effort */ }
        await sleep(80);
      }
    }

    await pool.query(
      `INSERT INTO ticketsmodule_operational_meta (id, last_full_sync, deal_count, last_source)
       VALUES (1, NOW(), $1, $2)
       ON CONFLICT (id) DO UPDATE SET last_full_sync=NOW(), deal_count=$1, last_source=$2`,
      [seen.length, source]
    ).catch(() => {});

    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`✅ operational fullSync (${source}): ${seen.length} сделок за ${mins} мин${withAutomation ? '' : ' (без автоматизаций)'}`);
    return { count: seen.length };
  } finally {
    syncing = false;
  }
}

// Recompute automation counts for every cached deal (background pass after a
// fast manual refresh, so the button returns quickly but counts still update).
async function runAutomationSweep() {
  const { rows } = await pool.query('SELECT deal_id FROM ticketsmodule_operational_deals');
  let bp = null;
  try { bp = { tpl: await getBizprocTemplates(), instances: await getActiveBizproc(true), taskMap: await getBizprocTasksByWorkflow() }; }
  catch (e) { console.error('bizproc prefetch:', e.message); }
  for (const { deal_id } of rows) {
    try { await updateAutomation(deal_id, await computeAutomation(deal_id, bp)); } catch (e) { /* best-effort */ }
    await sleep(80);
  }
  console.log(`✅ operational automation sweep: ${rows.length} сделок`);
}

// Manual "Обновить" button: fast deal-level re-pull now, automation in background.
async function refresh() {
  const res = await fullSync({ source: 'manual', withAutomation: false });
  runAutomationSweep().catch(e => console.error('bg automation sweep:', e.message));
  return res;
}

module.exports = { syncOneDeal, fullSync, refresh, runAutomationSweep, computeAutomation };

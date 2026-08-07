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
  F, PIPELINES, ENUM_FIELDS,
  getPipelineStages, buildEnumMap, resolveCompanies, fetchDeals,
} = require('./operational');
const { findChildrenOfDeal, resolveStageName } = require('./relations');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const firstOf = v => Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
const dateOnly = v => v ? String(v).slice(0, 10) : null;
const truthyBool = v => { const s = String(firstOf(v)); return s === '1' || s === 'Y' || s === 'true'; };

// ── Build the deal-level DB record from a raw Bitrix deal ────────────────────
async function buildDealRecord(d, ctx) {
  const categoryId = Number(d.__categoryId ?? d.CATEGORY_ID);
  const stageMeta = ctx.stageMeta[categoryId] || await getPipelineStages(categoryId);
  const semantic = stageMeta.byId?.[d.STAGE_ID]?.semantics || 'P';
  const payFactoryRaw = firstOf(d[F.payTermsFactory]);
  const payClientRaw = firstOf(d[F.payTermsClient]);
  const engId = firstOf(d[F.engineerId]);
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
    delivery_by_date: dateOnly(d[F.deliveryByDate]),
    factory_ship_date: dateOnly(d[F.factoryShip]),
    pay_factory: ctx.enumMaps[F.payTermsFactory]?.[String(payFactoryRaw)] || (payFactoryRaw || ''),
    pay_client: ctx.enumMaps[F.payTermsClient]?.[String(payClientRaw)] || (payClientRaw || ''),
    engineer_id: engId ? parseInt(engId, 10) : null,
    comment: firstOf(d[F.comment]) || '',
    red_flag: truthyBool(d[F.redFlag]),
    date_modify: d.DATE_MODIFY || null,
  };
}

// Upsert deal-level columns only — leaves the automation counts untouched so a
// fast (deal-level) sync doesn't wipe the numbers a slower pass computed.
async function upsertDealLevel(r) {
  await pool.query(
    `INSERT INTO ticketsmodule_operational_deals
      (deal_id, category_id, stage_id, stage_semantic, opportunity, currency_id, assigned_by_id, department_id,
       deal_title, company_id, company_name, contract_no, contract_date, delivery_by_date, factory_ship_date,
       pay_factory, pay_client, engineer_id, comment, red_flag, date_modify, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
     ON CONFLICT (deal_id) DO UPDATE SET
       category_id=$2, stage_id=$3, stage_semantic=$4, opportunity=$5, currency_id=$6, assigned_by_id=$7, department_id=$8,
       deal_title=$9, company_id=$10, company_name=$11, contract_no=$12, contract_date=$13, delivery_by_date=$14, factory_ship_date=$15,
       pay_factory=$16, pay_client=$17, engineer_id=$18, comment=$19, red_flag=$20, date_modify=$21, synced_at=NOW()`,
    [r.deal_id, r.category_id, r.stage_id, r.stage_semantic, r.opportunity, r.currency_id, r.assigned_by_id, r.department_id,
     r.deal_title, r.company_id, r.company_name, r.contract_no, r.contract_date, r.delivery_by_date, r.factory_ship_date,
     r.pay_factory, r.pay_client, r.engineer_id, r.comment, r.red_flag, r.date_modify]
  );
}

async function updateAutomation(dealId, a) {
  await pool.query(
    `UPDATE ticketsmodule_operational_deals SET open_processes=$2, overdue_tasks=$3, total_tasks=$4 WHERE deal_id=$1`,
    [dealId, a.open, a.overdue, a.total]
  );
}

// ── Per-deal automation snapshot: open child processes + overdue tasks ───────
async function computeAutomation(dealId) {
  let open = 0;
  try {
    const children = await findChildrenOfDeal(dealId);
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

  return { open, overdue, total };
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
    return;
  }
  const stageMeta = { [categoryId]: await getPipelineStages(categoryId) };
  const enumMaps = {};
  for (const code of ENUM_FIELDS) enumMaps[code] = await buildEnumMap(code);
  const companyMap = await resolveCompanies([d.COMPANY_ID]);
  const rec = await buildDealRecord({ ...d, __categoryId: categoryId }, { stageMeta, enumMaps, companyMap });
  await upsertDealLevel(rec);
  try { await updateAutomation(dealId, await computeAutomation(dealId)); } catch (e) { /* best-effort */ }
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
    const ctx = { stageMeta, enumMaps, companyMap };

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
      for (const id of seen) {
        try { await updateAutomation(id, await computeAutomation(id)); } catch (e) { /* best-effort */ }
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
  for (const { deal_id } of rows) {
    try { await updateAutomation(deal_id, await computeAutomation(deal_id)); } catch (e) { /* best-effort */ }
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

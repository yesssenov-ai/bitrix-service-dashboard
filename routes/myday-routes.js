// «Мой день» — персональная сводка на портале. v1: мои сделки в работе (pipeline
// P10–P80) из зеркала stat_deals по ответственному (bitrix_user_id). Дальше можно
// добавить сервисные заявки, задачи и т.д. Панель показывается, только если есть что.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const { getTodayRate } = require('../nbrk-exchange-rate');
const { b24 } = require('../bitrix');

// Стадия Bitrix → шаг воронки (как в Плане продаж). Только доконтракт P10–P80.
const STEP_OF = { NEW: 'P10', PREPARATION: 'P30', PREPAYMENT_INVOICE: 'P60', EXECUTING: 'P80' };
function stepOf(stage) { return STEP_OF[String(stage || '').replace(/^C\d:/, '')] || null; }
function dealBaseUrl() { try { return new URL(process.env.BITRIX_WEBHOOK).origin + '/crm/deal/details/'; } catch (e) { return null; } }

router.get('/', requireAuth(), async (req, res) => {
  try {
    const u = req.user;
    const bid = u.bitrix_user_id ? parseInt(u.bitrix_user_id, 10) : null;
    const out = { ok: true, name: u.display_name || u.username, role: u.role, hasBitrix: !!bid, deals: null };
    if (bid) {
      const rate = await getTodayRate();
      const base = dealBaseUrl();
      const { rows } = await pool.query(
        `SELECT deal_id, deal_title, company_name, stage_id, opportunity, currency_id, planned_purchase_date, likely_deal
           FROM ticketsmodule_stat_deals WHERE assigned_by_id=$1`, [bid]
      );
      const sumOf = d => (d.currency_id === 'USD' ? (parseFloat(d.opportunity) || 0) * rate : (parseFloat(d.opportunity) || 0));
      const pipe = [];
      for (const d of rows) {
        const step = stepOf(d.stage_id);
        if (!step) continue; // только воронка (не контракт/проигрыш)
        pipe.push({
          dealId: Number(d.deal_id),
          title: d.deal_title || d.company_name || ('Сделка #' + d.deal_id),
          company: d.company_name || '', step, sum: sumOf(d),
          hot: step === 'P80' || !!d.likely_deal,
          planned: d.planned_purchase_date || null,
          url: base ? base + d.deal_id + '/' : null,
        });
      }
      pipe.sort((a, b) => (b.hot - a.hot) || (b.sum - a.sum));
      out.deals = {
        count: pipe.length,
        sum: pipe.reduce((s, d) => s + d.sum, 0),
        hotCount: pipe.filter(d => d.hot).length,
        top: pipe.slice(0, 6),
      };
    }
    // Мои задачи Bitrix (best-effort; если нет прав на задачи у вебхука — просто пропустим).
    out.tasks = null;
    if (bid) {
      try {
        const base = (() => { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return ''; } })();
        const r = await b24('tasks.task.list', {
          filter: { RESPONSIBLE_ID: bid, '<REAL_STATUS': 5 }, // не завершённые/не отложенные
          select: ['ID', 'TITLE', 'DEADLINE', 'STATUS'],
          order: { DEADLINE: 'asc' }, start: 0,
        });
        const items = (r && r.result && (r.result.tasks || r.result)) || [];
        const now = Date.now();
        const list = items.map(t => {
          const id = t.id || t.ID, title = t.title || t.TITLE || '—', dl = t.deadline || t.DEADLINE || null;
          return { id, title, deadline: dl, overdue: dl ? (new Date(dl).getTime() < now) : false,
            url: base ? `${base}/company/personal/user/${bid}/tasks/task/view/${id}/` : null };
        });
        out.tasks = { count: list.length, overdueCount: list.filter(x => x.overdue).length, top: list.slice(0, 5) };
      } catch (e) { console.warn('myday tasks:', e.message); out.tasks = null; }
    }

    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) { console.error('myday:', e.message); res.status(500).json({ ok: false, error: e.message }); }
});

module.exports = { router };

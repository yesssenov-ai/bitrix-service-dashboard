// Глобальный поиск ЦУП: одно поле ищет по компаниям и сделкам из зеркал Postgres
// и ведёт в карточку Bitrix. Командная палитра (навигация по модулям) — на клиенте.
// Доступ: компании — любой авторизованный; сделки с суммами — руководящие роли,
// остальным только свои (assigned_by_id), чтобы не раскрывать чужие суммы.
const express = require('express');
const router = express.Router();
const { requireAuth, pool } = require('../auth');
const { getTodayRate } = require('../nbrk-exchange-rate');

const FULL_DEALS = ['admin', 'superadmin', 'coordinator', 'manager'];
function bitrixOrigin() { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return null; } }

router.get('/', requireAuth(), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const out = { ok: true, q, companies: [], deals: [] };
    if (q.length < 2) { res.set('Cache-Control', 'no-store'); return res.json(out); }

    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
    const idNum = /^\d+$/.test(q) ? parseInt(q, 10) : null;
    const origin = bitrixOrigin();
    const u = req.user;
    const bid = u.bitrix_user_id ? parseInt(u.bitrix_user_id, 10) : null;
    const fullDeals = FULL_DEALS.includes(u.role);

    // ── Компании ──
    try {
      const { rows } = await pool.query(
        `SELECT id, title, industry_name, bin, city, deal_count
           FROM ticketsmodule_companies
          WHERE merged_into IS NULL
            AND (title ILIKE $1 OR bin ILIKE $1 ${idNum != null ? 'OR id = $2' : ''})
          ORDER BY (title ILIKE $1) DESC, deal_count DESC NULLS LAST
          LIMIT 6`,
        idNum != null ? [like, String(idNum)] : [like]
      );
      out.companies = rows.map(c => ({
        id: c.id, title: c.title || ('Компания #' + c.id),
        industry: c.industry_name || '', bin: c.bin || '', city: c.city || '',
        dealCount: c.deal_count || 0,
        url: origin ? origin + '/crm/company/details/' + c.id + '/' : null,
      }));
    } catch (e) { console.warn('search companies:', e.message); }

    // ── Сделки ──
    try {
      const rate = await getTodayRate();
      const params = [like];
      let where = `(deal_title ILIKE $1 OR company_name ILIKE $1 OR instrument_name ILIKE $1`;
      if (idNum != null) { params.push(idNum); where += ` OR deal_id = $${params.length}`; }
      where += ')';
      if (!fullDeals) { params.push(bid || -1); where += ` AND assigned_by_id = $${params.length}`; }
      const { rows } = await pool.query(
        `SELECT deal_id, deal_title, company_name, stage_id, opportunity, currency_id, instrument_name
           FROM ticketsmodule_stat_deals
          WHERE ${where}
          ORDER BY (deal_title ILIKE $1) DESC, synced_at DESC NULLS LAST
          LIMIT 8`,
        params
      );
      out.deals = rows.map(d => {
        const raw = parseFloat(d.opportunity) || 0;
        return {
          id: Number(d.deal_id),
          title: d.deal_title || ('Сделка #' + d.deal_id),
          company: d.company_name || '',
          instrument: d.instrument_name || '',
          stage: String(d.stage_id || '').replace(/^C\d+:/, ''),
          sum: d.currency_id === 'USD' ? raw * rate : raw,
          url: origin ? origin + '/crm/deal/details/' + d.deal_id + '/' : null,
        };
      });
    } catch (e) { console.warn('search deals:', e.message); }

    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    console.error('search:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = { router };

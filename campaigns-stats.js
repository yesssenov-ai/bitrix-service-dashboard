// Аналитика рассылок: статусы доставки по каждому письму тянем из Selzy методом
// checkEmail (по сохранённому email_id = recipients.message_id). Selzy хранит
// статусы ~1 месяц, поэтому мы их периодически подтягиваем и фиксируем в своей БД
// (в колонках-таймстампах), чтобы аналитика жила и после того, как Selzy забудет.
//
// Что умеет Selzy отдать по письму (checkEmail):
//   ok_sent → отправлено, ok_delivered → доставлено, ok_read → открыто,
//   ok_link_visited → перешёл по ссылке (клик), ok_unsubscribed → отписался,
//   ok_spam_folder → в спаме (считаем доставленным), ok_fbl → жалоба,
//   err_* → отказ (bounce). Пересылку email не отслеживает НИКТО — это не баг.
const { pool } = require('./auth');

const SELZY_KEY = process.env.SELZY_API_KEY || '';
const SELZY_CHECK_URL = process.env.SELZY_CHECK_URL || 'https://api.selzy.com/en/api/checkEmail';

// ── Схема: до-колонки жизненного цикла письма на существующей таблице получателей
let _schema;
function ensureStatsSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ;
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ;
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS unsub_at TIMESTAMPTZ;
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ;
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS track_status VARCHAR(40);
      ALTER TABLE ticketsmodule_campaign_recipients ADD COLUMN IF NOT EXISTS track_checked_at TIMESTAMPTZ;
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// Ошибки Selzy, которые «ещё в пути» (не финальный отказ) — их не считаем bounce.
const RETRYABLE = new Set(['err_will_retry', 'err_resend', 'err_no_dns', 'err_no_smtp', 'err_destination_misconfigured', 'err_spam_may_retry']);
const DELIVERED_STATES = new Set(['ok_delivered', 'ok_spam_folder', 'ok_read', 'ok_link_visited', 'ok_unsubscribed', 'ok_fbl']);
const OPENED_STATES = new Set(['ok_read', 'ok_link_visited']);

async function applyStatus(recipientId, status) {
  const S = String(status || '');
  const sets = ['track_status=$2', 'track_checked_at=NOW()'];
  if (DELIVERED_STATES.has(S)) sets.push('delivered_at=COALESCE(delivered_at,NOW())');
  if (OPENED_STATES.has(S)) sets.push('opened_at=COALESCE(opened_at,NOW())');
  if (S === 'ok_link_visited') sets.push('clicked_at=COALESCE(clicked_at,NOW())');
  if (S === 'ok_unsubscribed') sets.push('unsub_at=COALESCE(unsub_at,NOW())');
  if (S.startsWith('err_') && !RETRYABLE.has(S)) sets.push('bounced_at=COALESCE(bounced_at,NOW())');
  await pool.query(`UPDATE ticketsmodule_campaign_recipients SET ${sets.join(', ')} WHERE id=$1`, [recipientId, S]);
}

// Подтянуть свежие статусы из Selzy по одной кампании.
async function refreshCampaign(campaignId) {
  await ensureStatsSchema();
  if (!SELZY_KEY) return { ok: false, error: 'SELZY_API_KEY не задан — аналитика доставки недоступна' };
  // Берём письма, у которых есть email_id и статус ещё не финальный (не клик/не отказ).
  const { rows } = await pool.query(
    `SELECT id, message_id FROM ticketsmodule_campaign_recipients
       WHERE campaign_id=$1 AND message_id IS NOT NULL
         AND clicked_at IS NULL AND bounced_at IS NULL`, [campaignId]);
  if (!rows.length) return getCampaignAnalytics(campaignId);
  const map = new Map();
  rows.forEach(r => map.set(String(r.message_id), r.id));
  const ids = [...map.keys()];
  let checked = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const params = new URLSearchParams();
    params.set('format', 'json');
    params.set('api_key', SELZY_KEY);
    params.set('email_id', batch.join(','));
    let d = {};
    try {
      const res = await fetch(SELZY_CHECK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString(),
      });
      d = await res.json().catch(() => ({}));
    } catch (e) { return { ok: false, error: 'Selzy недоступен: ' + e.message }; }
    if (d && d.error) return { ok: false, error: String(d.error) + (d.code ? ' [' + d.code + ']' : '') };
    const statuses = (d && d.result && d.result.statuses) || (d && d.statuses) || [];
    for (const s of statuses) {
      const rid = map.get(String(s.id != null ? s.id : s.email_id));
      if (!rid) continue;
      await applyStatus(rid, s.status);
      checked++;
    }
  }
  const out = await getCampaignAnalytics(campaignId);
  out.refreshed = checked;
  return out;
}

// Аналитика по одной кампании: воронка + детализация по каждому адресату.
async function getCampaignAnalytics(campaignId) {
  await ensureStatsSchema();
  const c = (await pool.query(
    'SELECT id,name,subject,status,total,sent,failed,created_at,sent_at FROM ticketsmodule_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!c) return { ok: false, error: 'Кампания не найдена' };
  const { rows } = await pool.query(
    `SELECT email, company_name, status, message_id, at,
            delivered_at, opened_at, clicked_at, unsub_at, bounced_at, track_status, error
       FROM ticketsmodule_campaign_recipients
      WHERE campaign_id=$1
      ORDER BY (clicked_at IS NOT NULL) DESC, (opened_at IS NOT NULL) DESC, (delivered_at IS NOT NULL) DESC, email`, [campaignId]);
  const agg = { total: rows.length, sent: 0, delivered: 0, opened: 0, clicked: 0, unsub: 0, bounced: 0, failed: 0, pending: 0 };
  rows.forEach(r => {
    if (r.status === 'sent') agg.sent++;
    else if (r.status === 'failed') agg.failed++;
    else if (r.status === 'pending') agg.pending++;
    if (r.delivered_at) agg.delivered++;
    if (r.opened_at) agg.opened++;
    if (r.clicked_at) agg.clicked++;
    if (r.unsub_at) agg.unsub++;
    if (r.bounced_at) agg.bounced++;
  });
  return { ok: true, campaign: c, agg, recipients: rows };
}

// Сводная аналитика по всем отправленным кампаниям + суммарные тоталы.
async function getOverall() {
  await ensureStatsSchema();
  const { rows: campaigns } = await pool.query(`
    SELECT c.id, c.name, c.subject, c.status, c.sent_at, c.created_at,
      COUNT(r.*) FILTER (WHERE r.status='sent')            AS sent,
      COUNT(r.*) FILTER (WHERE r.delivered_at IS NOT NULL) AS delivered,
      COUNT(r.*) FILTER (WHERE r.opened_at  IS NOT NULL)   AS opened,
      COUNT(r.*) FILTER (WHERE r.clicked_at IS NOT NULL)   AS clicked,
      COUNT(r.*) FILTER (WHERE r.unsub_at   IS NOT NULL)   AS unsub,
      COUNT(r.*) FILTER (WHERE r.bounced_at IS NOT NULL)   AS bounced
    FROM ticketsmodule_campaigns c
    LEFT JOIN ticketsmodule_campaign_recipients r ON r.campaign_id=c.id
    WHERE c.status IN ('sent','sending')
    GROUP BY c.id
    ORDER BY c.sent_at DESC NULLS LAST, c.id DESC`);
  const totals = { sent: 0, delivered: 0, opened: 0, clicked: 0, unsub: 0, bounced: 0, campaigns: campaigns.length };
  campaigns.forEach(c => {
    ['sent', 'delivered', 'opened', 'clicked', 'unsub', 'bounced'].forEach(k => { c[k] = Number(c[k] || 0); totals[k] += c[k]; });
  });
  return { ok: true, totals, campaigns };
}

module.exports = { ensureStatsSchema, refreshCampaign, getCampaignAnalytics, getOverall };

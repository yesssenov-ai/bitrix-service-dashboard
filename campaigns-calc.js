// Модуль «Рассылки»: массовые письма клиентам по сфере деятельности (Bitrix
// INDUSTRY). Аудитория (компании + их e-mail из компаний и контактов) кэшируется
// в БД, письма шлём через Resend с отдельного поддомена. Отписка + стоп-лист.
const fetch = require('node-fetch');
const crypto = require('crypto');
const { b24 } = require('./bitrix');
const { pool } = require('./auth');

const RESEND_KEY = process.env.RESEND_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'x';
const APP_BASE = process.env.APP_BASE_URL || 'https://nms.prolabsupport.kz';
// Отдельный поддомен для рассылок (репутация не бьёт по основной почте).
// Пропиши CAMPAIGN_FROM="ProLabSupport <news@news.prolabsupport.kz>" в env, когда
// заведёшь поддомен и подтвердишь его в Resend (SPF/DKIM/DMARC).
const CAMPAIGN_FROM = process.env.CAMPAIGN_FROM || 'ProLabSupport <news@prolabsupport.kz>';
const SEND_BATCH = 20;          // писем за «пачку»
const SEND_PAUSE_MS = 1500;     // пауза между пачками (троттлинг)

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let _schema = null;
function ensureSchema() {
  if (_schema) return _schema;
  _schema = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ticketsmodule_campaign_audience (
        email VARCHAR(200) PRIMARY KEY,
        company_id BIGINT,
        company_name VARCHAR(400),
        industry_id VARCHAR(40),
        industry_name VARCHAR(200),
        source VARCHAR(20),
        contact_name VARCHAR(200),
        synced_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS idx_camp_aud_ind ON ticketsmodule_campaign_audience(industry_id);
      CREATE INDEX IF NOT EXISTS idx_camp_aud_comp ON ticketsmodule_campaign_audience(company_id);
      CREATE TABLE IF NOT EXISTS ticketsmodule_campaigns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(300),
        subject VARCHAR(400),
        from_name VARCHAR(200),
        body_html TEXT,
        created_by INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'draft',
        total INTEGER DEFAULT 0, sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ticketsmodule_campaign_recipients (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES ticketsmodule_campaigns(id) ON DELETE CASCADE,
        email VARCHAR(200),
        company_name VARCHAR(400),
        status VARCHAR(20) DEFAULT 'pending',
        error TEXT, message_id TEXT, at TIMESTAMPTZ);
      CREATE INDEX IF NOT EXISTS idx_camp_rec_cid ON ticketsmodule_campaign_recipients(campaign_id);
      CREATE TABLE IF NOT EXISTS ticketsmodule_campaign_suppression (
        email VARCHAR(200) PRIMARY KEY,
        reason VARCHAR(60),
        at TIMESTAMPTZ DEFAULT NOW());
    `);
  })().catch(e => { _schema = null; throw e; });
  return _schema;
}

// ── Справочник сфер (INDUSTRY) ──────────────────────────────────────────────
let _indMap = null, _indAt = 0;
async function industryMap() {
  if (_indMap && Date.now() - _indAt < 6 * 3600 * 1000) return _indMap;
  const map = {};
  try {
    const { result } = await b24('crm.status.list', { filter: { ENTITY_ID: 'INDUSTRY' }, order: { SORT: 'ASC' } });
    (result || []).forEach(s => { map[s.STATUS_ID] = s.NAME; });
  } catch (e) { console.error('industryMap:', e.message); }
  _indMap = map; _indAt = Date.now();
  return map;
}

function extractEmails(mf) {
  if (!mf) return [];
  const arr = Array.isArray(mf) ? mf : [mf];
  return [...new Set(arr.map(x => (x && typeof x === 'object') ? x.VALUE : x)
    .filter(Boolean).map(e => String(e).trim().toLowerCase()).filter(e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
}

// ── Синхронизация аудитории из Bitrix (компании + контакты) ─────────────────
let _syncing = false, _lastSync = null;
async function syncAudience() {
  if (_syncing) return { skipped: 'running' };
  _syncing = true;
  await ensureSchema();
  const indMap = await industryMap();
  const rows = new Map(); // email -> row
  try {
    // 1) Компании: TITLE + INDUSTRY + EMAIL
    let start = 0, guard = 0;
    while (guard++ < 400) {
      const res = await b24('crm.company.list', { select: ['ID', 'TITLE', 'INDUSTRY', 'EMAIL'], order: { ID: 'ASC' }, start });
      const arr = res.result || [];
      for (const c of arr) {
        const industryId = c.INDUSTRY || '';
        for (const em of extractEmails(c.EMAIL)) {
          if (!rows.has(em)) rows.set(em, { email: em, companyId: c.ID, companyName: c.TITLE || '', industryId, industryName: indMap[industryId] || (industryId ? industryId : 'Без сферы'), source: 'company', contactName: null });
        }
      }
      if (res.next == null) break; start = res.next; await sleep(120);
    }
    // 2) Контакты по компаниям (батчами по 50 id) — email контактов, сфера от компании
    const compIndustry = {}; // companyId -> {industryId, name}
    { const r = await pool.query('SELECT DISTINCT company_id, industry_id, industry_name, company_name FROM ticketsmodule_campaign_audience'); r.rows.forEach(x => { compIndustry[x.company_id] = { industryId: x.industry_id, industryName: x.industry_name, companyName: x.company_name }; }); }
    // список id компаний берём из уже собранных email-строк + докидываем из Bitrix постранично контакты
    let cstart = 0, cguard = 0;
    while (cguard++ < 800) {
      const res = await b24('crm.contact.list', { select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'COMPANY_ID'], order: { ID: 'ASC' }, start: cstart });
      const arr = res.result || [];
      for (const ct of arr) {
        const emails = extractEmails(ct.EMAIL); if (!emails.length) continue;
        const cid = ct.COMPANY_ID || null;
        // сфера/название компании — из карты собранных (если контакт привязан к компании, что уже в аудитории)
        let info = null;
        if (cid) {
          // найдём среди уже собранных email-строк компанию
          for (const v of rows.values()) { if (String(v.companyId) === String(cid)) { info = v; break; } }
        }
        const nm = [ct.LAST_NAME, ct.NAME].filter(Boolean).join(' ').trim() || null;
        for (const em of emails) {
          if (!rows.has(em)) rows.set(em, {
            email: em, companyId: cid, companyName: info ? info.companyName : '',
            industryId: info ? info.industryId : '', industryName: info ? info.industryName : 'Без сферы',
            source: 'contact', contactName: nm,
          });
        }
      }
      if (res.next == null) break; cstart = res.next; await sleep(120);
    }
    // 3) Перезаписываем кэш
    await pool.query('DELETE FROM ticketsmodule_campaign_audience');
    const vals = [...rows.values()];
    for (let i = 0; i < vals.length; i += 500) {
      const chunk = vals.slice(i, i + 500);
      const ph = []; const params = [];
      chunk.forEach((v, j) => {
        const b = j * 7;
        ph.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`);
        params.push(v.email, v.companyId || null, v.companyName || '', v.industryId || '', v.industryName || 'Без сферы', v.source, v.contactName);
      });
      if (chunk.length) await pool.query(
        `INSERT INTO ticketsmodule_campaign_audience (email, company_id, company_name, industry_id, industry_name, source, contact_name) VALUES ${ph.join(',')} ON CONFLICT (email) DO NOTHING`, params);
    }
    _lastSync = new Date().toISOString();
    console.log(`campaigns: аудитория синхронизирована — ${vals.length} e-mail`);
    return { ok: true, emails: vals.length };
  } catch (e) {
    console.error('syncAudience error:', e.message);
    return { ok: false, error: e.message };
  } finally { _syncing = false; }
}

async function getIndustries() {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT industry_id, MAX(industry_name) AS name, COUNT(DISTINCT company_id) AS companies, COUNT(*) AS emails
       FROM ticketsmodule_campaign_audience GROUP BY industry_id ORDER BY name`);
  return { lastSync: _lastSync, syncing: _syncing, industries: rows.map(r => ({ id: r.industry_id, name: r.name || 'Без сферы', companies: Number(r.companies), emails: Number(r.emails) })) };
}

async function getCompanies(industryId) {
  await ensureSchema();
  const { rows } = await pool.query(
    `SELECT company_id, MAX(company_name) AS name,
            json_agg(json_build_object('email', email, 'name', contact_name, 'source', source) ORDER BY email) AS emails
       FROM ticketsmodule_campaign_audience WHERE industry_id=$1 GROUP BY company_id ORDER BY name`, [industryId || '']);
  return rows.map(r => ({ companyId: r.company_id, name: r.name || ('Компания #' + r.company_id), emails: r.emails || [] }));
}

// ── Кампании ────────────────────────────────────────────────────────────────
async function createCampaign(payload, byBid) {
  await ensureSchema();
  const { name, subject, fromName, bodyHtml } = payload || {};
  const { rows } = await pool.query(
    `INSERT INTO ticketsmodule_campaigns (name, subject, from_name, body_html, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [name || 'Без названия', subject || '', fromName || '', bodyHtml || '', byBid || null]);
  return { id: rows[0].id };
}
async function updateCampaign(id, payload) {
  await ensureSchema();
  const { name, subject, fromName, bodyHtml } = payload || {};
  await pool.query('UPDATE ticketsmodule_campaigns SET name=$1, subject=$2, from_name=$3, body_html=$4 WHERE id=$5 AND status=\'draft\'',
    [name || '', subject || '', fromName || '', bodyHtml || '', id]);
  return { ok: true };
}
async function listCampaigns() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT id, name, subject, status, total, sent, failed, created_at, sent_at FROM ticketsmodule_campaigns ORDER BY id DESC LIMIT 200');
  return rows;
}
async function getCampaign(id) {
  await ensureSchema();
  const { rows } = await pool.query('SELECT * FROM ticketsmodule_campaigns WHERE id=$1', [id]);
  if (!rows.length) return null;
  const rec = await pool.query('SELECT status, COUNT(*)::int n FROM ticketsmodule_campaign_recipients WHERE campaign_id=$1 GROUP BY status', [id]);
  const counts = {}; rec.rows.forEach(r => { counts[r.status] = r.n; });
  return { ...rows[0], counts };
}
async function deleteCampaign(id) {
  await ensureSchema();
  await pool.query('DELETE FROM ticketsmodule_campaigns WHERE id=$1 AND status IN (\'draft\',\'sent\',\'failed\')', [id]);
  return { ok: true };
}
async function setRecipients(campaignId, emails) {
  await ensureSchema();
  const uniq = [...new Set((emails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean))];
  await pool.query('DELETE FROM ticketsmodule_campaign_recipients WHERE campaign_id=$1', [campaignId]);
  // подтягиваем название компании к каждому email
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const ph = []; const params = [campaignId];
    chunk.forEach((em, j) => { ph.push(`($1,$${j+2})`); params.push(em); });
    await pool.query(
      `INSERT INTO ticketsmodule_campaign_recipients (campaign_id, email, company_name)
       SELECT $1, e.email, COALESCE(a.company_name,'')
         FROM unnest(ARRAY[${chunk.map((_, j) => `$${j+2}`).join(',')}]::text[]) e(email)
         LEFT JOIN ticketsmodule_campaign_audience a ON a.email=e.email`, params);
  }
  await pool.query('UPDATE ticketsmodule_campaigns SET total=(SELECT COUNT(*) FROM ticketsmodule_campaign_recipients WHERE campaign_id=$1) WHERE id=$1', [campaignId]);
  return { ok: true, count: uniq.length };
}

// Токен отписки (стабильный на email).
function unsubToken(email) {
  const mac = crypto.createHmac('sha256', JWT_SECRET).update('unsub:' + email).digest('base64url').slice(0, 16);
  return Buffer.from(email).toString('base64url') + '.' + mac;
}
function unsubVerify(token) {
  try {
    const [b, mac] = String(token).split('.');
    const email = Buffer.from(b, 'base64url').toString('utf8');
    const good = crypto.createHmac('sha256', JWT_SECRET).update('unsub:' + email).digest('base64url').slice(0, 16);
    return mac === good ? email : null;
  } catch (e) { return null; }
}
async function suppress(email, reason) {
  await ensureSchema();
  await pool.query('INSERT INTO ticketsmodule_campaign_suppression (email, reason) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING', [String(email).toLowerCase(), reason || 'unsub']);
  return { ok: true };
}

function personalize(html, rec) {
  return String(html || '')
    .replace(/\{\{\s*Компания\s*\}\}/gi, esc(rec.company_name || ''))
    .replace(/\{\{\s*Company\s*\}\}/gi, esc(rec.company_name || ''));
}
function wrapEmail(bodyHtml, unsubUrl) {
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;color:#1a1e27;font-size:15px;line-height:1.6">
    ${bodyHtml}
    <hr style="border:none;border-top:1px solid #e3e6ef;margin:24px 0">
    <p style="color:#9ca3af;font-size:12px">ProLabSupport · Казахстан<br>
    Вы получили это письмо как клиент ProLabSupport. <a href="${unsubUrl}" style="color:#9ca3af">Отписаться</a></p>
  </div>`;
}

async function sendOne(rec, campaign) {
  const unsubUrl = `${APP_BASE}/api/campaigns/unsub?t=${unsubToken(rec.email)}`;
  const html = wrapEmail(personalize(campaign.body_html, rec), unsubUrl);
  const from = campaign.from_name ? campaign.from_name.replace(/<[^>]*>/g, '').trim() + ' <' + (CAMPAIGN_FROM.match(/<([^>]+)>/) || [null, CAMPAIGN_FROM])[1] + '>' : CAMPAIGN_FROM;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [rec.email], subject: campaign.subject || '', html, headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((d && (d.message || d.error)) || ('HTTP ' + res.status));
  return d.id || null;
}

// Запуск рассылки (в фоне). Троттлинг + стоп-лист + запись статусов.
async function sendCampaign(campaignId) {
  await ensureSchema();
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY не задан' };
  const c = (await pool.query('SELECT * FROM ticketsmodule_campaigns WHERE id=$1', [campaignId])).rows[0];
  if (!c) return { ok: false, error: 'Кампания не найдена' };
  if (c.status === 'sending') return { ok: false, error: 'Рассылка уже идёт' };
  await pool.query('UPDATE ticketsmodule_campaigns SET status=\'sending\', sent_at=NOW() WHERE id=$1', [campaignId]);
  (async () => {
    let sent = 0, failed = 0;
    try {
      const { rows: recs } = await pool.query(
        `SELECT r.* FROM ticketsmodule_campaign_recipients r
           WHERE r.campaign_id=$1 AND r.status='pending'
             AND NOT EXISTS (SELECT 1 FROM ticketsmodule_campaign_suppression s WHERE s.email=r.email)`, [campaignId]);
      for (let i = 0; i < recs.length; i += SEND_BATCH) {
        const batch = recs.slice(i, i + SEND_BATCH);
        for (const rec of batch) {
          try {
            const mid = await sendOne(rec, c);
            await pool.query('UPDATE ticketsmodule_campaign_recipients SET status=\'sent\', message_id=$1, at=NOW() WHERE id=$2', [mid, rec.id]);
            sent++;
          } catch (e) {
            await pool.query('UPDATE ticketsmodule_campaign_recipients SET status=\'failed\', error=$1, at=NOW() WHERE id=$2', [String(e.message).slice(0, 300), rec.id]);
            failed++;
          }
        }
        await pool.query('UPDATE ticketsmodule_campaigns SET sent=$1, failed=$2 WHERE id=$3', [sent, failed, campaignId]);
        if (i + SEND_BATCH < recs.length) await sleep(SEND_PAUSE_MS);
      }
      // отписанных помечаем
      await pool.query(`UPDATE ticketsmodule_campaign_recipients r SET status='unsub'
        WHERE r.campaign_id=$1 AND r.status='pending' AND EXISTS (SELECT 1 FROM ticketsmodule_campaign_suppression s WHERE s.email=r.email)`, [campaignId]);
      await pool.query('UPDATE ticketsmodule_campaigns SET status=\'sent\', sent=$1, failed=$2 WHERE id=$3', [sent, failed, campaignId]);
      console.log(`campaigns: кампания #${campaignId} — отправлено ${sent}, ошибок ${failed}`);
    } catch (e) {
      console.error('sendCampaign run error:', e.message);
      await pool.query('UPDATE ticketsmodule_campaigns SET status=\'failed\' WHERE id=$1', [campaignId]).catch(() => {});
    }
  })();
  return { ok: true, started: true };
}

module.exports = {
  ensureSchema, syncAudience, getIndustries, getCompanies,
  createCampaign, updateCampaign, listCampaigns, getCampaign, deleteCampaign,
  setRecipients, sendCampaign, suppress, unsubVerify, industryMap,
};

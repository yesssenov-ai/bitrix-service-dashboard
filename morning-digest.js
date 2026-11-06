// Утренний персональный дайджест сотрудникам ЦУП (будни, утро по Алматы).
// Канал: личный Telegram (связка ticketsmodule_telegram_links), фолбэк — корпоративная
// почта (логин = e-mail). Шлём ТОЛЬКО если есть что показать (без спама пустыми).
// Содержимое v1: просроченные задачи Bitrix + сводка своего pipeline (P10–P80) с
// горячими сделками. Сервисные заявки инженеров можно добавить следующим шагом.
const { pool } = require('./auth');
const { b24 } = require('./bitrix');
const { getTodayRate } = require('./nbrk-exchange-rate');
const notif = require('./notifications');

const STEP_OF = { NEW: 'P10', PREPARATION: 'P30', PREPAYMENT_INVOICE: 'P60', EXECUTING: 'P80' };
function stepOf(stage) { return STEP_OF[String(stage || '').replace(/^C\d+:/, '')] || null; }
function dealOrigin() { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return null; } }
function mln(v) { return (Math.round(((v || 0) / 1e6) * 10) / 10).toLocaleString('ru-RU') + ' млн ₸'; }
function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
const looksEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));

// Собрать данные дайджеста по одному сотруднику (bid = bitrix_user_id).
async function collect(bid, rate, origin) {
  let pipeCount = 0, pipeSum = 0, hot = [];
  try {
    const { rows } = await pool.query(
      `SELECT deal_id, deal_title, company_name, stage_id, opportunity, currency_id, likely_deal
         FROM ticketsmodule_stat_deals WHERE assigned_by_id=$1`, [bid]
    );
    for (const d of rows) {
      const step = stepOf(d.stage_id); if (!step) continue;
      const sum = d.currency_id === 'USD' ? (parseFloat(d.opportunity) || 0) * rate : (parseFloat(d.opportunity) || 0);
      pipeCount++; pipeSum += sum;
      if (step === 'P80' || d.likely_deal) hot.push({ id: Number(d.deal_id), title: d.deal_title || d.company_name || ('Сделка #' + d.deal_id), sum });
    }
    hot.sort((a, b) => b.sum - a.sum);
  } catch (e) { console.warn('digest deals:', e.message); }

  let overdue = [];
  try {
    const r = await b24('tasks.task.list', {
      filter: { RESPONSIBLE_ID: bid, '<REAL_STATUS': 5 },
      select: ['ID', 'TITLE', 'DEADLINE'], order: { DEADLINE: 'asc' }, start: 0,
    });
    const items = (r && r.result && (r.result.tasks || r.result)) || [];
    const now = Date.now();
    overdue = items
      .filter(t => { const dl = t.deadline || t.DEADLINE; return dl && new Date(dl).getTime() < now; })
      .map(t => ({ id: t.id || t.ID, title: t.title || t.TITLE || '—' }));
  } catch (e) { console.warn('digest tasks:', e.message); }

  return { pipeCount, pipeSum, hot, overdue };
}

function buildTelegram(name, data, origin) {
  const L = [];
  L.push(`🌅 <b>Доброе утро, ${esc(name)}!</b>`);
  L.push('Сводка на сегодня:');
  if (data.overdue.length) {
    L.push('');
    L.push(`⏰ <b>Просроченные задачи: ${data.overdue.length}</b>`);
    data.overdue.slice(0, 5).forEach(t => L.push(`• ${esc(t.title)}`));
    if (data.overdue.length > 5) L.push(`…и ещё ${data.overdue.length - 5}`);
  }
  if (data.hot.length) {
    L.push('');
    L.push(`🔥 <b>Горячие сделки: ${data.hot.length}</b>`);
    data.hot.slice(0, 5).forEach(d => {
      const t = esc(d.title) + (d.sum ? ` — ${mln(d.sum)}` : '');
      L.push(origin ? `• <a href="${origin}/crm/deal/details/${d.id}/">${t}</a>` : `• ${t}`);
    });
  }
  if (data.pipeCount) { L.push(''); L.push(`💼 В работе всего: ${data.pipeCount} сделок на ${mln(data.pipeSum)}`); }
  L.push('');
  L.push(`🔗 <a href="${process.env.DASH_URL || 'https://nms.prolabsupport.kz'}/portal.html">Открыть ЦУП</a>`);
  return L.join('\n');
}

function buildEmail(name, data, origin) {
  const dash = (process.env.DASH_URL || 'https://nms.prolabsupport.kz') + '/portal.html';
  const block = (title, rows) => rows.length ? `<h3 style="margin:16px 0 6px;font-size:15px">${title}</h3><ul style="margin:0;padding-left:18px;font-size:14px;color:#374151">${rows.join('')}</ul>` : '';
  const od = data.overdue.slice(0, 5).map(t => `<li>${esc(t.title)}</li>`);
  if (data.overdue.length > 5) od.push(`<li>…и ещё ${data.overdue.length - 5}</li>`);
  const hot = data.hot.slice(0, 5).map(d => {
    const t = esc(d.title) + (d.sum ? ` — ${mln(d.sum)}` : '');
    return `<li>${origin ? `<a href="${origin}/crm/deal/details/${d.id}/" style="color:#C53B2F">${t}</a>` : t}</li>`;
  });
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto">
    <div style="background:#C53B2F;padding:18px 22px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:17px">🌅 Доброе утро, ${esc(name)}!</h2></div>
    <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:18px 22px;border-radius:0 0 10px 10px">
      ${block('⏰ Просроченные задачи: ' + data.overdue.length, od)}
      ${block('🔥 Горячие сделки: ' + data.hot.length, hot)}
      ${data.pipeCount ? `<p style="font-size:14px;color:#374151;margin-top:14px">💼 В работе всего: <b>${data.pipeCount}</b> сделок на <b>${mln(data.pipeSum)}</b></p>` : ''}
      <div style="margin-top:18px"><a href="${dash}" style="background:#C53B2F;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Открыть ЦУП</a></div>
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:14px">ProLabSupport · ЦУП · утренняя сводка</p>
  </div>`;
}

// Отправить дайджесты. onlyBid — опционально: только одному (для теста).
// Возвращает сводку {users, sent, skipped, tg, email}.
async function sendMorningDigests(opts) {
  opts = opts || {};
  const origin = dealOrigin();
  let rate = 1; try { rate = await getTodayRate(); } catch (e) {}
  let where = 'u.active = true AND u.bitrix_user_id IS NOT NULL';
  const params = [];
  if (opts.onlyBid) { params.push(parseInt(opts.onlyBid, 10)); where += ` AND u.bitrix_user_id = $${params.length}`; }
  const { rows: users } = await pool.query(
    `SELECT u.username, u.display_name, u.bitrix_user_id, tl.telegram_chat_id
       FROM ticketsmodule_users u
       LEFT JOIN ticketsmodule_telegram_links tl ON tl.bitrix_user_id = u.bitrix_user_id
      WHERE ${where}`, params
  );
  const stat = { users: users.length, sent: 0, skipped: 0, tg: 0, email: 0 };
  for (const u of users) {
    try {
      const data = await collect(u.bitrix_user_id, rate, origin);
      const hasSomething = data.overdue.length || data.hot.length || data.pipeCount;
      if (!hasSomething) { stat.skipped++; continue; }
      const name = u.display_name || u.username || 'коллега';
      let ok = false;
      if (u.telegram_chat_id) { ok = await notif.tgTo(u.telegram_chat_id, buildTelegram(name, data, origin)); if (ok) stat.tg++; }
      if (!ok && looksEmail(u.username)) { ok = await notif.sendEmailTo(u.username, 'ЦУП · Ваша сводка на сегодня', buildEmail(name, data, origin)); if (ok) stat.email++; }
      if (ok) stat.sent++; else stat.skipped++;
    } catch (e) { console.warn('digest user', u.bitrix_user_id, e.message); stat.skipped++; }
  }
  console.log('🌅 morning digest:', JSON.stringify(stat));
  return stat;
}

module.exports = { sendMorningDigests };

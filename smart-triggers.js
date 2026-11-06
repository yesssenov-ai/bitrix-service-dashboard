// Умные триггеры ЦУП.
//  🛡 Гарантии, истекающие ≤30 дн. — еженедельно (пн) в чат Руководства + координаторам.
//  💸 Дебиторка — еженедельный отчёт (пн) ЛИЧНО админам (roles admin/superadmin), НЕ в
//     чат Руководства; плюс событийные алерты: как только появляется новый долг или
//     контракт впервые уходит в просрочку → админам + ответственному менеджеру сделки.
// Застрявшие сделки сейчас отключены (по решению — вернёмся позже).
const { pool } = require('./auth');
const notif = require('./notifications');
let USERS = {}, COORDINATORS = new Set();
try { const c = require('./constants'); USERS = c.USERS; COORDINATORS = c.COORDINATORS; } catch (e) {}

const WARRANTY_DAYS = 30;
function dealOrigin() { try { return new URL(process.env.BITRIX_WEBHOOK).origin; } catch (e) { return null; } }
function esc(s) { return String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
function money(v) { v = Number(v) || 0; return Math.abs(v) >= 1e6 ? (Math.round(v / 1e5) / 10).toLocaleString('ru-RU') + ' млн ₸' : Math.round(v).toLocaleString('ru-RU') + ' ₸'; }
function mgrName(id) { return (id != null && USERS[id]) ? USERS[id] : null; }
const looksEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
function dealLink(origin, id, label) { return (origin && id) ? `<a href="${origin}/crm/deal/details/${id}/">${label}</a>` : label; }

// ── Получатели ──
async function adminRecipients() {
  const { rows } = await pool.query(
    `SELECT u.username, u.display_name, u.bitrix_user_id, tl.telegram_chat_id
       FROM ticketsmodule_users u
       LEFT JOIN ticketsmodule_telegram_links tl ON tl.bitrix_user_id = u.bitrix_user_id
      WHERE u.active = true AND u.role IN ('admin','superadmin')`
  );
  return rows;
}
async function coordinatorChats() {
  const ids = [...(COORDINATORS || [])].map(Number).filter(Boolean);
  if (!ids.length) return [];
  const { rows } = await pool.query(
    `SELECT telegram_chat_id FROM ticketsmodule_telegram_links WHERE bitrix_user_id = ANY($1::int[])`, [ids]
  );
  return rows.map(r => r.telegram_chat_id).filter(Boolean);
}
// Отправить персонально списку пользователей: Telegram если привязан, иначе почта.
async function sendToUsers(recips, text, subject, html) {
  let tg = 0, mail = 0;
  for (const u of recips) {
    let ok = false;
    if (u.telegram_chat_id) { ok = await notif.tgTo(u.telegram_chat_id, text); if (ok) tg++; }
    if (!ok && looksEmail(u.username)) { const m = await notif.sendEmailTo(u.username, subject, html); if (m) mail++; }
  }
  return { tg, mail };
}
// Ответственные менеджеры по сделкам (bitrix_deal_id → {chatId, name}).
async function managersForDeals(dealIds) {
  const ints = [...new Set(dealIds.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n)))];
  const map = {};
  if (!ints.length) return map;
  const { rows } = await pool.query(
    `SELECT d.deal_id, d.assigned_by_id, tl.telegram_chat_id
       FROM ticketsmodule_stat_deals d
       LEFT JOIN ticketsmodule_telegram_links tl ON tl.bitrix_user_id = d.assigned_by_id
      WHERE d.deal_id = ANY($1::int[])`, [ints]
  );
  for (const r of rows) map[String(r.deal_id)] = { chatId: r.telegram_chat_id || null, name: mgrName(r.assigned_by_id) };
  return map;
}

// ── 🛡 Гарантии (еженедельно) ──
async function collectWarranty() {
  const { rows } = await pool.query(
    `SELECT deal_id, deal_title, company_name, instrument_name, warranty_end, assigned_by_id
       FROM ticketsmodule_stat_deals
      WHERE warranty_end IS NOT NULL AND warranty_end >= CURRENT_DATE AND warranty_end <= CURRENT_DATE + $1::int
      ORDER BY warranty_end ASC LIMIT 40`, [WARRANTY_DAYS]
  );
  return rows.map(r => ({
    id: Number(r.deal_id),
    title: r.company_name || r.deal_title || ('Сделка #' + r.deal_id),
    instrument: r.instrument_name || '',
    date: r.warranty_end ? new Date(r.warranty_end).toLocaleDateString('ru', { day: '2-digit', month: '2-digit' }) : '',
    manager: mgrName(r.assigned_by_id),
  }));
}
function warrantyTG(list, origin) {
  const L = [`🛡 <b>Гарантии истекают (≤${WARRANTY_DAYS} дн.): ${list.length}</b>`, 'Повод предложить сервис:'];
  list.slice(0, 15).forEach(w => L.push(`• ${dealLink(origin, w.id, esc(w.title))}${w.instrument ? ' · ' + esc(w.instrument) : ''} — до ${w.date}${w.manager ? ' · ' + esc(w.manager) : ''}`));
  if (list.length > 15) L.push(`…и ещё ${list.length - 15}`);
  return L.join('\n');
}
function warrantyEmail(list) {
  const li = list.slice(0, 30).map(w => `<li>${esc(w.title)}${w.instrument ? ' · ' + esc(w.instrument) : ''} — до ${w.date}${w.manager ? ' · ' + esc(w.manager) : ''}</li>`).join('');
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:#C53B2F;padding:16px 20px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:16px">🛡 Гарантии истекают (≤${WARRANTY_DAYS} дн.): ${list.length}</h2></div>
    <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px">
      <p style="font-size:13px;color:#6b7280;margin:0 0 8px">Повод предложить сервис.</p>
      <ul style="margin:0;padding-left:18px;font-size:13.5px;color:#374151;line-height:1.6">${li}</ul></div></div>`;
}
async function sendWarrantyWeekly() {
  const origin = dealOrigin();
  const list = await collectWarranty();
  const stat = { warranty: list.length, mgmt: false, coordChats: 0 };
  if (!list.length) { console.log('🛡 warranty weekly: пусто'); return stat; }
  const tg = warrantyTG(list, origin);
  try { if (notif.tgMgt) { await notif.tgMgt(tg); stat.mgmt = true; } } catch (e) { console.warn('warranty mgmt:', e.message); }
  try { const chats = await coordinatorChats(); for (const c of chats) { await notif.tgTo(c, tg); stat.coordChats++; } } catch (e) { console.warn('warranty coord tg:', e.message); }
  try { if (notif.sendEmail) await notif.sendEmail(`ЦУП · Гарантии истекают (${WARRANTY_DAYS} дн.)`, warrantyEmail(list)); } catch (e) { console.warn('warranty email:', e.message); }
  console.log('🛡 warranty weekly sent:', JSON.stringify(stat));
  return stat;
}

// ── 💸 Дебиторка: еженедельный отчёт админам ──
async function collectDebt() {
  const { rows } = await pool.query(
    `SELECT contractor, contract, department, debt, overdue_days
       FROM ticketsmodule_onec_debt WHERE debt > 0`
  );
  const totalDebt = rows.reduce((a, r) => a + Number(r.debt || 0), 0);
  const overdueRows = rows.filter(r => Number(r.overdue_days) > 0);
  const totalOverdue = overdueRows.reduce((a, r) => a + Number(r.debt || 0), 0);
  const top = overdueRows.slice().sort((a, b) => Number(b.debt) - Number(a.debt)).slice(0, 12);
  return { count: rows.length, totalDebt, overdueCount: overdueRows.length, totalOverdue, top };
}
function debtWeeklyTG(d) {
  const L = [`💸 <b>Дебиторка — ${new Date().toLocaleDateString('ru', { day: '2-digit', month: '2-digit', year: 'numeric' })}</b>`];
  L.push(`Всего долг: ${money(d.totalDebt)} · контрактов: ${d.count}`);
  L.push(`Просрочено: ${money(d.totalOverdue)} · контрактов: ${d.overdueCount}`);
  if (d.top.length) { L.push(''); L.push('<b>Топ по просрочке:</b>'); d.top.forEach(r => L.push(`• ${esc(r.contractor || '—')} — ${money(r.debt)} · ${r.overdue_days} дн.${r.department ? ' · ' + esc(r.department) : ''}`)); }
  return L.join('\n');
}
function debtWeeklyEmail(d) {
  const li = d.top.map(r => `<li>${esc(r.contractor || '—')} — ${money(r.debt)} · ${r.overdue_days} дн.${r.department ? ' · ' + esc(r.department) : ''}</li>`).join('');
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:#101624;padding:16px 20px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:16px">💸 Дебиторка — отчёт</h2></div>
    <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px">
      <p style="font-size:14px;margin:0 0 4px">Всего долг: <b>${money(d.totalDebt)}</b> · контрактов: ${d.count}</p>
      <p style="font-size:14px;margin:0 0 10px">Просрочено: <b style="color:#dc2626">${money(d.totalOverdue)}</b> · контрактов: ${d.overdueCount}</p>
      ${d.top.length ? `<h3 style="font-size:14px;margin:12px 0 6px">Топ по просрочке</h3><ul style="margin:0;padding-left:18px;font-size:13.5px;color:#374151;line-height:1.6">${li}</ul>` : ''}
    </div></div>`;
}
async function sendDebtWeekly() {
  const d = await collectDebt();
  const stat = { contracts: d.count, overdue: d.overdueCount, tg: 0, mail: 0 };
  if (!d.count) { console.log('💸 debt weekly: долгов нет'); return stat; }
  const admins = await adminRecipients();
  const r = await sendToUsers(admins, debtWeeklyTG(d), 'ЦУП · Дебиторка — отчёт (понедельник)', debtWeeklyEmail(d));
  stat.tg = r.tg; stat.mail = r.mail;
  console.log('💸 debt weekly sent:', JSON.stringify(stat));
  return stat;
}

// ── 💸 Дебиторка: событийные алерты (новый долг / переход в просрочку) ──
async function ensureStateTable() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_debt_alert_state (
    id VARCHAR(120) PRIMARY KEY,
    last_debt NUMERIC DEFAULT 0,
    last_overdue INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW())`);
}
function alertsTG(items, origin, forAdmin) {
  const L = [forAdmin ? `🔴 <b>Новая дебиторка/просрочка: ${items.length}</b>` : `🔴 <b>По вашим сделкам — новая дебиторка/просрочка: ${items.length}</b>`];
  items.slice(0, 20).forEach(a => {
    const tag = a.reason === 'new_debt' ? 'новый долг' : 'просрочка';
    const who = forAdmin && a.manager ? ' · ' + esc(a.manager) : '';
    const link = a.bitrix_deal_id ? dealLink(origin, a.bitrix_deal_id, esc(a.contractor || a.contract || ('Сделка #' + a.bitrix_deal_id))) : esc(a.contractor || '—');
    L.push(`• ${link} — ${money(a.debt)}${a.overdue_days > 0 ? ' · просрочка ' + a.overdue_days + ' дн.' : ''} · <i>${tag}</i>${who}`);
  });
  if (items.length > 20) L.push(`…и ещё ${items.length - 20}`);
  return L.join('\n');
}
function alertsEmail(items) {
  const li = items.slice(0, 40).map(a => {
    const tag = a.reason === 'new_debt' ? 'новый долг' : 'просрочка';
    return `<li>${esc(a.contractor || '—')}${a.contract ? ' · ' + esc(a.contract) : ''} — ${money(a.debt)}${a.overdue_days > 0 ? ' · просрочка ' + a.overdue_days + ' дн.' : ''} · ${tag}${a.manager ? ' · ' + esc(a.manager) : ''}</li>`;
  }).join('');
  return `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto">
    <div style="background:#dc2626;padding:16px 20px;border-radius:10px 10px 0 0"><h2 style="color:#fff;margin:0;font-size:16px">🔴 Новая дебиторка / просрочка: ${items.length}</h2></div>
    <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:16px 20px;border-radius:0 0 10px 10px">
      <ul style="margin:0;padding-left:18px;font-size:13.5px;color:#374151;line-height:1.6">${li}</ul></div></div>`;
}
async function checkDebtAlerts() {
  await ensureStateTable();
  const origin = dealOrigin();
  const { rows } = await pool.query(
    `SELECT id, contractor, contract, department, debt, overdue_days, bitrix_deal_id FROM ticketsmodule_onec_debt`
  );
  const { rows: stRows } = await pool.query(`SELECT id, last_debt, last_overdue FROM ticketsmodule_debt_alert_state`);
  const firstRun = stRows.length === 0;
  const state = new Map(stRows.map(r => [r.id, r]));
  const alerts = [];
  for (const r of rows) {
    const debt = Number(r.debt || 0), od = Number(r.overdue_days || 0);
    if (!firstRun) {
      const prev = state.get(r.id);
      const hadDebt = prev && Number(prev.last_debt) > 0;
      const wasOverdue = prev && Number(prev.last_overdue) > 0;
      if (debt > 0 && !hadDebt) alerts.push({ ...r, debt, overdue_days: od, reason: 'new_debt' });
      else if (debt > 0 && od > 0 && !wasOverdue) alerts.push({ ...r, debt, overdue_days: od, reason: 'new_overdue' });
    }
  }
  // Обновить состояние по всем текущим строкам одним запросом.
  if (rows.length) {
    await pool.query(
      `INSERT INTO ticketsmodule_debt_alert_state (id, last_debt, last_overdue, updated_at)
       SELECT id, d, o, NOW() FROM unnest($1::varchar[], $2::numeric[], $3::int[]) AS t(id, d, o)
       ON CONFLICT (id) DO UPDATE SET last_debt=EXCLUDED.last_debt, last_overdue=EXCLUDED.last_overdue, updated_at=NOW()`,
      [rows.map(r => r.id), rows.map(r => Number(r.debt || 0)), rows.map(r => Number(r.overdue_days || 0))]
    );
  }
  if (firstRun) { console.log('💸 debt alerts: первичная инициализация state, без рассылки'); return { seeded: true, alerts: 0 }; }
  if (!alerts.length) return { alerts: 0 };

  const mgrMap = await managersForDeals(alerts.map(a => a.bitrix_deal_id).filter(Boolean));
  for (const a of alerts) { const m = a.bitrix_deal_id ? mgrMap[String(parseInt(a.bitrix_deal_id, 10))] : null; a.manager = m ? m.name : null; }

  // Админам — одной сводкой.
  try {
    const admins = await adminRecipients();
    await sendToUsers(admins, alertsTG(alerts, origin, true), 'ЦУП · Новая дебиторка/просрочка', alertsEmail(alerts));
  } catch (e) { console.warn('debt alerts admins:', e.message); }

  // Каждому ответственному менеджеру — его контракты.
  const byMgr = new Map();
  for (const a of alerts) {
    const m = a.bitrix_deal_id ? mgrMap[String(parseInt(a.bitrix_deal_id, 10))] : null;
    if (m && m.chatId) { if (!byMgr.has(m.chatId)) byMgr.set(m.chatId, []); byMgr.get(m.chatId).push(a); }
  }
  for (const [chat, items] of byMgr) { try { await notif.tgTo(chat, alertsTG(items, origin, false)); } catch (e) {} }

  console.log('💸 debt alerts sent:', JSON.stringify({ alerts: alerts.length, managers: byMgr.size }));
  return { alerts: alerts.length, managers: byMgr.size };
}

module.exports = { sendWarrantyWeekly, sendDebtWeekly, checkDebtAlerts, collectWarranty, collectDebt };

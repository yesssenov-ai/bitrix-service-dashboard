// Уведомления модуля «Логистика». Переиспользует существующие каналы:
//   • персональный Telegram-DM по Bitrix-ID (sendPersonalTg, таблица связок)
//   • уведомление в Bitrix: комментарий в таймлайн сделки (гарантированно видно)
//     + персональное im.notify (best-effort, если у вебхука есть scope im)
// Кому: ответственный сделки, ответственный закупки, руководители (координаторы).
// Каждый сигнал по (заказ, причина) шлём ОДИН раз — дедуп в таблице.
const { pool } = require('./auth');
const { b24 } = require('./bitrix');
const { sendPersonalTg, logNotification, setPool: setMgrPool } = require('./manager-notifications');
const { COORDINATORS, USERS } = require('./constants');
const { getBoard } = require('./logistics-calc');

setMgrPool(pool); // на случай, если модуль ещё не проинициализирован

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dfmt = s => { if (!s) return ''; const [y, m, d] = String(s).split('-'); return `${d}.${m}.${y}`; };

// Руководитель сейлса = глава отдела ответственного за сделку (из оргструктуры
// Bitrix: user.get → UF_DEPARTMENT → department.get → UF_HEAD). Кэш в процессе.
const headCache = {};
async function getSalesHead(userId) {
  if (!userId) return null;
  if (headCache[userId] !== undefined) return headCache[userId];
  let head = null;
  try {
    const { result } = await b24('user.get', { ID: userId });
    const u = (result || [])[0];
    const deps = (u && u.UF_DEPARTMENT) || [];
    if (deps.length) {
      const { result: dres } = await b24('department.get', { ID: deps[0] });
      const d = (dres || [])[0];
      if (d && d.UF_HEAD) head = parseInt(d.UF_HEAD, 10);
    }
  } catch (e) { /* best-effort */ }
  headCache[userId] = head;
  return head;
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_logistics_notified (
    order_id INTEGER NOT NULL, reason VARCHAR(40) NOT NULL, notified_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (order_id, reason))`);
  tableReady = true;
}
async function alreadyNotified(orderId, reason) {
  const { rows } = await pool.query('SELECT 1 FROM ticketsmodule_logistics_notified WHERE order_id=$1 AND reason=$2', [orderId, reason]);
  return rows.length > 0;
}
async function markNotified(orderId, reason) {
  await pool.query('INSERT INTO ticketsmodule_logistics_notified (order_id, reason) VALUES ($1,$2) ON CONFLICT DO NOTHING', [orderId, reason]);
}

// Какие сигналы активны у заказа сейчас.
function reasonsFor(o) {
  const rs = [];
  if (o.deadlineOverdue) rs.push({ key: 'overdue', emoji: '⚠️', title: `Просрочка по договору ${Math.abs(o.deadlineLeft)} дн` });
  else if (o.deadlineSoon) rs.push({ key: 'soon', emoji: '⏰', title: `Скоро дедлайн: осталось ${o.deadlineLeft} дн` });
  if (o.stuck) rs.push({ key: 'stuck', emoji: '🐌', title: `Застрял на этапе «${o.milestoneLabel}» ${o.currentStageDays} дн` });
  return rs;
}

function tgText(o, r) {
  const po = o.po ? `PO ${esc(o.po)} · ` : '';
  const dl = o.deadline ? `\n🎯 Сдать клиенту до <b>${dfmt(o.deadline)}</b>` : '';
  const mgr = [o.managerDeal, o.managerPurch].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ');
  return `${r.emoji} <b>Логистика: ${esc(r.title)}</b>\n${po}${esc(o.instrument || ('Заказ #' + o.id))}\nСтадия ${o.milestone}/11 · ${esc(o.milestoneLabel)}${dl}\nОтдел: ${esc(o.dept)}${mgr ? ' · ' + esc(mgr) : ''}`;
}

async function notifyOrder(o, r) {
  // руководитель сейлса из оргструктуры; если не резолвится — фолбэк на координаторов
  const salesHead = await getSalesHead(o.dealRespId);
  const heads = salesHead ? [salesHead] : [...COORDINATORS];
  const recipients = [...new Set([o.dealRespId, o.purchRespId, ...heads].filter(Boolean))];
  const text = tgText(o, r);
  const plain = text.replace(/<[^>]+>/g, '');
  for (const uid of recipients) {
    let ok = false;
    try { ok = await sendPersonalTg(uid, text); } catch (e) { /* канал best-effort */ }
    try { await logNotification({ itemId: o.id, reason: 'logistics_' + r.key, channel: 'telegram', recipientId: uid, recipientLabel: USERS[uid] || ('#' + uid), success: !!ok }); } catch (e) {}
    // Bitrix: персональное уведомление (если доступен scope im — иначе тихо пропустим)
    try { await b24('im.notify.personal.add', { USER_ID: uid, MESSAGE: plain, TAG: `logistics_${o.id}_${r.key}` }); } catch (e) {}
  }
  // Bitrix: комментарий в таймлайн сделки — гарантированно виден в CRM
  if (o.dealId) {
    try {
      await b24('crm.timeline.comment.add', {
        fields: { ENTITY_ID: o.dealId, ENTITY_TYPE: 'deal',
          COMMENT: `🚚 ${r.emoji} Логистика: ${r.title} — ${o.po ? 'PO ' + o.po + ' · ' : ''}${o.instrument || ''} (стадия ${o.milestone}/11 «${o.milestoneLabel}»${o.deadline ? ', сдать до ' + dfmt(o.deadline) : ''})` },
      });
    } catch (e) { /* best-effort */ }
  }
}

// Основной проход: читает кэш борда и рассылает новые сигналы (дедуп по (заказ, причина)).
async function runLogisticsAlerts() {
  try {
    await ensureTable();
    const board = await getBoard(); // из кэша, без тяжёлого пересчёта
    const orders = (board && board.orders) || [];
    let sent = 0;
    for (const o of orders) {
      if (o.done) continue;
      for (const r of reasonsFor(o)) {
        if (await alreadyNotified(o.id, r.key)) continue;
        await notifyOrder(o, r);
        await markNotified(o.id, r.key);
        sent++;
      }
    }
    if (sent) console.log(`logistics alerts: отправлено сигналов — ${sent}`);
  } catch (e) {
    console.error('runLogisticsAlerts error:', e.message);
  }
}

module.exports = { runLogisticsAlerts };

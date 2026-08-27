// ProLab AI — действия с подтверждением: Bitrix-задача / Telegram / почта.
// Получатели: ответственные менеджеры или их руководители (РОП). Сначала prepare
// (превью получателей + текст), затем execute (по кнопке «Отправить»).
const { pool } = require('./auth');
const { getTodayRate } = require('./nbrk-exchange-rate');
const { USERS, USER_EMAILS } = require('./constants');
const { EMPLOYEE_DEPT } = require('./dept-map');
const { b24 } = require('./bitrix');
const mn = require('./manager-notifications');
try { mn.setPool && mn.setPool(pool); } catch (_) {}

// Явная карта РОП по отделу (Bitrix-ID руководителя). Приоритетнее оргструктуры Bitrix,
// т.к. в CRM закреплены не всегда. Ключи — названия отделов из EMPLOYEE_DEPT.
const DEPT_HEAD = {
  'Элементный': 12,     // Айжан Байжигитова
  'Хроматография': 14,  // Канат Жунусов — Хроматография и клеточный анализ
  'Электрохимия': 13,   // Назерке Марат
  'ОРМ': 13,            // Назерке Марат
  'Materials': 13,      // Назерке Марат — Материаловедение / General Lab
  'Тренинг-центр': 39,  // Мансур Сейтжан
};

function fmtMln(v) { const m = (v || 0) / 1e6; return (Math.abs(m) >= 100 ? Math.round(m) : Math.round(m * 10) / 10).toLocaleString('ru-RU') + ' млн ₸'; }

// Руководитель (РОП) сотрудника через оргструктуру Bitrix (UF_HEAD отдела).
const _headCache = {};
async function getSalesHead(userId) {
  if (userId == null) return null;
  if (_headCache[userId] !== undefined) return _headCache[userId];
  // 1) Явная карта РОП по отделу сотрудника — приоритетна.
  const dept = EMPLOYEE_DEPT[userId];
  if (dept && DEPT_HEAD[dept] && DEPT_HEAD[dept] !== userId) { _headCache[userId] = DEPT_HEAD[dept]; return DEPT_HEAD[dept]; }
  // 2) Иначе — оргструктура Bitrix (UF_HEAD отдела).
  let head = null;
  try {
    const { result } = await b24('user.get', { ID: userId });
    const deps = (result && result[0] && result[0].UF_DEPARTMENT) || [];
    if (deps.length) { const { result: dres } = await b24('department.get', { ID: deps[0] }); head = (dres && dres[0] && dres[0].UF_HEAD) ? parseInt(dres[0].UF_HEAD, 10) : null; }
  } catch (_) {}
  if (head === userId) head = null;   // сам себе не руководитель
  _headCache[userId] = head; return head;
}

// Собрать сделки по получателям (менеджеры или руководители).
async function groupRecipients(dealIds, target) {
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const ids = (dealIds || []).map(x => parseInt(x, 10)).filter(Boolean).slice(0, 500);
  if (!ids.length) return {};
  const { rows } = await pool.query(`SELECT deal_id, company_name, assigned_by_id, (${kzt}) v FROM ticketsmodule_stat_deals WHERE deal_id = ANY($1)`, [ids]);
  // deal → менеджер
  const byMgr = {};
  for (const r of rows) { const mid = r.assigned_by_id; if (!mid) continue; (byMgr[mid] = byMgr[mid] || []).push({ dealId: r.deal_id, company: r.company_name || '', sum: Math.round(parseFloat(r.v) || 0), mgr: mid }); }
  if (target !== 'heads') return byMgr;
  // менеджер → руководитель, объединяем сделки под руководителем
  const byHead = {};
  for (const mid of Object.keys(byMgr)) { const head = await getSalesHead(parseInt(mid, 10)); const key = head || mid; (byHead[key] = byHead[key] || []).push(...byMgr[mid].map(d => Object.assign({}, d))); }
  return byHead;
}

// Получатели для режима «задачи»: группируем ОТКРЫТЫЕ задачи по ответственному
// (или по его руководителю). Это те, кто должен закрыть задачи.
async function groupTaskRecipients(dealIds, target) {
  const { openTasksForDeals } = require('./plsai-tasks');
  const rate = await getTodayRate();
  const kzt = `CASE WHEN currency_id='USD' THEN opportunity*${rate} ELSE opportunity END`;
  const ids = (dealIds || []).map(x => parseInt(x, 10)).filter(Boolean).slice(0, 1000);
  if (!ids.length) return {};
  const { rows } = await pool.query(`SELECT deal_id, company_name FROM ticketsmodule_stat_deals WHERE deal_id = ANY($1)
    UNION SELECT deal_id, company_name FROM ticketsmodule_operational_deals WHERE deal_id = ANY($1)`, [ids]);
  const companyOf = {}; rows.forEach(r => { companyOf[r.deal_id] = r.company_name || ''; });
  const byDeal = await openTasksForDeals(ids);
  const now = Date.now();
  const byResp = {};
  for (const did of Object.keys(byDeal)) {
    for (const t of (byDeal[did] || [])) {
      const rid = parseInt(t.responsibleId ?? t.RESPONSIBLE_ID, 10); if (!rid) continue;
      const dl = t.deadline ?? t.DEADLINE ?? null; const overdue = dl && new Date(dl).getTime() < now;
      (byResp[rid] = byResp[rid] || []).push({ dealId: did, company: companyOf[did] || '', title: (t.title ?? t.TITLE ?? '').toString(), deadline: dl ? String(dl).slice(0, 10) : null, overdue: !!overdue, taskId: t.id ?? t.ID });
    }
  }
  if (target !== 'heads') return byResp;
  const byHead = {};
  for (const rid of Object.keys(byResp)) { const head = await getSalesHead(parseInt(rid, 10)); const key = head || rid; (byHead[key] = byHead[key] || []).push(...byResp[rid]); }
  return byHead;
}

function deliverable(id, channel) {
  if (channel === 'task') return true;
  if (channel === 'email') return !!USER_EMAILS[id];
  return null; // telegram проверяем асинхронно
}
function defaultText(target, mode) {
  if (mode === 'tasks') {
    return target === 'heads'
      ? 'Добрый день! У сотрудников вашей команды есть незакрытые задачи в CRM (ниже) — прошу проконтролировать выполнение, особенно просроченные.'
      : 'Добрый день! За вами числятся незакрытые задачи в CRM (ниже) — просьба выполнить их, в первую очередь просроченные.';
  }
  return target === 'heads'
    ? 'Добрый день! По сделкам вашей команды ниже давно не обновлялись комментарии в CRM — прошу поручить менеджерам обновить статус.'
    : 'Добрый день! По вашим сделкам ниже давно не обновлялись комментарии в CRM — просьба обновить статус по каждой.';
}

async function prepare({ dealIds, channel, target, text, mode }) {
  channel = ['task', 'telegram', 'email'].includes(channel) ? channel : 'task';
  target = target === 'heads' ? 'heads' : 'managers';
  const isTasks = mode === 'tasks';
  const groups = isTasks ? await groupTaskRecipients(dealIds, target) : await groupRecipients(dealIds, target);
  const recipients = [];
  for (const rid of Object.keys(groups)) {
    const id = parseInt(rid, 10); const items = groups[rid];
    let deliver = deliverable(id, channel);
    if (channel === 'telegram') { try { deliver = !!(await mn.getManagerTelegramChatId(id)); } catch (_) { deliver = false; } }
    const rec = { id, name: USERS[id] || ('#' + id), email: USER_EMAILS[id] || null, deliverable: deliver };
    if (isTasks) { rec.taskCount = items.length; rec.overdueCount = items.filter(t => t.overdue).length; rec.sum = 0; rec.deals = items.slice(0, 20); }
    else { rec.dealCount = items.length; rec.sum = items.reduce((s, d) => s + d.sum, 0); rec.deals = items.slice(0, 20); }
    recipients.push(rec);
  }
  recipients.sort((a, b) => isTasks ? ((b.overdueCount - a.overdueCount) || (b.taskCount - a.taskCount)) : (b.sum - a.sum));
  return { channel, target, mode: isTasks ? 'tasks' : 'deals', text: text || defaultText(target, mode), recipients, recipientCount: recipients.length, dealCount: (dealIds || []).length };
}

function listText(items, html) {
  return items.map(d => {
    if (d.title != null) { // задача
      const dl = d.deadline ? ` (до ${d.deadline})` : ''; const od = d.overdue ? (html ? ' ⚠️' : ' [просрочена]') : '';
      return html ? `• <b>${escapeHtml(d.company)}</b>: ${escapeHtml(d.title)}${escapeHtml(dl)}${od}` : `• ${d.company}: ${d.title}${dl}${od}`;
    }
    return html ? `• <b>${escapeHtml(d.company)}</b> — ${fmtMln(d.sum)}` : `• ${d.company} — ${fmtMln(d.sum)}`;
  }).join(html ? '<br>' : '\n');
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function execute({ dealIds, channel, target, text, userName, mode }) {
  channel = ['task', 'telegram', 'email'].includes(channel) ? channel : 'task';
  target = target === 'heads' ? 'heads' : 'managers';
  const isTasks = mode === 'tasks';
  text = String(text || defaultText(target, mode)).slice(0, 2000);
  const groups = isTasks ? await groupTaskRecipients(dealIds, target) : await groupRecipients(dealIds, target);
  const listLabel = isTasks ? 'Задачи:' : 'Сделки:';
  const emailSubj = isTasks ? 'ЦУП: незакрытые задачи, требующие выполнения' : 'ЦУП: сделки, требующие обновления комментариев';
  const results = [];
  for (const rid of Object.keys(groups)) {
    const id = parseInt(rid, 10); const items = groups[rid]; const name = USERS[id] || ('#' + id);
    try {
      if (channel === 'task') {
        const desc = text + '\n\n' + listLabel + '\n' + listText(items, false) + `\n\n— поставлено через ЦУП (${userName || 'ProLab AI'})`;
        const title = isTasks ? `ЦУП: выполнить незакрытые задачи (${items.length})` : `ЦУП: обновить комментарии по сделкам (${items.length})`;
        const fields = { TITLE: title, DESCRIPTION: desc, RESPONSIBLE_ID: id };
        if (items[0] && items[0].dealId) fields.UF_CRM_TASK = [`D_${items[0].dealId}`];
        const data = await b24('tasks.task.add', { fields });
        results.push({ id, name, ok: !!(data && data.result), via: 'Bitrix-задача' });
      } else if (channel === 'telegram') {
        const html = `<b>${escapeHtml(text)}</b><br><br>${listText(items, true)}`;
        const ok = await mn.sendPersonalTg(id, html);
        results.push({ id, name, ok: !!ok, via: 'Telegram', error: ok ? null : 'нет привязки Telegram' });
      } else {
        const li = items.map(d => d.title != null
          ? `<li><b>${escapeHtml(d.company)}</b>: ${escapeHtml(d.title)}${d.deadline ? ' (до ' + escapeHtml(d.deadline) + ')' : ''}${d.overdue ? ' ⚠️' : ''}</li>`
          : `<li><b>${escapeHtml(d.company)}</b> — ${fmtMln(d.sum)}</li>`).join('');
        const html = `<p>${escapeHtml(text)}</p><ul>${li}</ul><p style="color:#888">— отправлено через ЦУП (${escapeHtml(userName || 'ProLab AI')})</p>`;
        const ok = await mn.sendPersonalEmail(id, emailSubj, html);
        results.push({ id, name, ok: !!ok, via: 'Почта', error: ok ? null : 'нет e-mail' });
      }
    } catch (e) { results.push({ id, name, ok: false, via: channel, error: e.message }); }
  }
  const sent = results.filter(r => r.ok).length;
  return { channel, target, mode: isTasks ? 'tasks' : 'deals', sent, total: results.length, results };
}

module.exports = { prepare, execute };

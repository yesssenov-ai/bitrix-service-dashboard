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

function deliverable(id, channel) {
  if (channel === 'task') return true;
  if (channel === 'email') return !!USER_EMAILS[id];
  return null; // telegram проверяем асинхронно
}
function defaultText(target) {
  return target === 'heads'
    ? 'Добрый день! По сделкам вашей команды ниже давно не обновлялись комментарии в CRM — прошу поручить менеджерам обновить статус.'
    : 'Добрый день! По вашим сделкам ниже давно не обновлялись комментарии в CRM — просьба обновить статус по каждой.';
}

async function prepare({ dealIds, channel, target, text }) {
  channel = ['task', 'telegram', 'email'].includes(channel) ? channel : 'task';
  target = target === 'heads' ? 'heads' : 'managers';
  const groups = await groupRecipients(dealIds, target);
  const recipients = [];
  for (const rid of Object.keys(groups)) {
    const id = parseInt(rid, 10); const deals = groups[rid];
    let deliver = deliverable(id, channel);
    if (channel === 'telegram') { try { deliver = !!(await mn.getManagerTelegramChatId(id)); } catch (_) { deliver = false; } }
    recipients.push({ id, name: USERS[id] || ('#' + id), email: USER_EMAILS[id] || null, deliverable: deliver, dealCount: deals.length, sum: deals.reduce((s, d) => s + d.sum, 0), deals: deals.slice(0, 20) });
  }
  recipients.sort((a, b) => b.sum - a.sum);
  return { channel, target, text: text || defaultText(target), recipients, recipientCount: recipients.length, dealCount: (dealIds || []).length };
}

function listText(deals, html) {
  return deals.map(d => (html ? `• <b>${escapeHtml(d.company)}</b> — ${fmtMln(d.sum)}` : `• ${d.company} — ${fmtMln(d.sum)}`)).join(html ? '<br>' : '\n');
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function execute({ dealIds, channel, target, text, userName }) {
  channel = ['task', 'telegram', 'email'].includes(channel) ? channel : 'task';
  target = target === 'heads' ? 'heads' : 'managers';
  text = String(text || defaultText(target)).slice(0, 2000);
  const groups = await groupRecipients(dealIds, target);
  const results = [];
  for (const rid of Object.keys(groups)) {
    const id = parseInt(rid, 10); const deals = groups[rid]; const name = USERS[id] || ('#' + id);
    try {
      if (channel === 'task') {
        const desc = text + '\n\nСделки:\n' + listText(deals, false) + `\n\n— поставлено через ЦУП (${userName || 'ProLab AI'})`;
        const fields = { TITLE: `ЦУП: обновить комментарии по сделкам (${deals.length})`, DESCRIPTION: desc, RESPONSIBLE_ID: id };
        if (deals[0]) fields.UF_CRM_TASK = [`D_${deals[0].dealId}`];
        const data = await b24('tasks.task.add', { fields });
        results.push({ id, name, ok: !!(data && data.result), via: 'Bitrix-задача' });
      } else if (channel === 'telegram') {
        const html = `<b>${escapeHtml(text)}</b><br><br>${listText(deals, true)}`;
        const ok = await mn.sendPersonalTg(id, html);
        results.push({ id, name, ok: !!ok, via: 'Telegram', error: ok ? null : 'нет привязки Telegram' });
      } else {
        const html = `<p>${escapeHtml(text)}</p><ul>${deals.map(d => `<li><b>${escapeHtml(d.company)}</b> — ${fmtMln(d.sum)}</li>`).join('')}</ul><p style="color:#888">— отправлено через ЦУП (${escapeHtml(userName || 'ProLab AI')})</p>`;
        const ok = await mn.sendPersonalEmail(id, 'ЦУП: сделки, требующие обновления комментариев', html);
        results.push({ id, name, ok: !!ok, via: 'Почта', error: ok ? null : 'нет e-mail' });
      }
    } catch (e) { results.push({ id, name, ok: false, via: channel, error: e.message }); }
  }
  const sent = results.filter(r => r.ok).length;
  return { channel, target, sent, total: results.length, results };
}

module.exports = { prepare, execute };

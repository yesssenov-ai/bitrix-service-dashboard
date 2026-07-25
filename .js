warning: in the working copy of 'manager-notifications.js', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/manager-notifications.js b/manager-notifications.js[m
[1mindex e9ea9a9..12c9254 100644[m
[1m--- a/manager-notifications.js[m
[1m+++ b/manager-notifications.js[m
[36m@@ -133,9 +133,70 @@[m [masync function notifyEngineerAssigned(managerId, { itemId, title, engineerName,[m
   await sendPersonalEmail(managerId, `👤 Назначен инженер: заявка #${itemId}`, html);[m
 }[m
 [m
[32m+[m[32m// ── Notify engineer + sales manager: full job assignment details ──────────────[m
[32m+[m
[32m+[m[32masync function notifyJobAssigned({ engineerId, managerId, itemId, title, reason, svcLabel,[m
[32m+[m[32m  engineerName, assignDate, startDate, endDate, clientName, contractLabel,[m
[32m+[m[32m  managerName, instrLabel, location, url, dealUrl }) {[m
[32m+[m
[32m+[m[32m  const headerText = reason || 'Назначен инженер на заявку';[m
[32m+[m[32m  const cleanTitle = (title || '').replace(/^[-\s–—]+/, '').replace(/[-\s–—]+$/, '').trim() || `#${itemId}`;[m
[32m+[m
[32m+[m[32m  const row = (label, val) => val ? `${label}: <b>${esc(val)}</b>\n` : '';[m
[32m+[m[32m  const tgText = `🔧 <b>${esc(headerText)}</b>\n` +[m
[32m+[m[32m    `📋 Заявка на сервис #${itemId}: ${esc(cleanTitle)}\n\n` +[m
[32m+[m[32m    row('Тип услуг', svcLabel) +[m
[32m+[m[32m    row('Ответственный инженер', engineerName) +[m
[32m+[m[32m    row('Дата назначения', assignDate) +[m
[32m+[m[32m    row('Дата начала работ', startDate) +[m
[32m+[m[32m    row('Дата завершения работ', endDate) +[m
[32m+[m[32m    row('Клиент / Компания', clientName) +[m
[32m+[m[32m    row('Контракт', contractLabel) +[m
[32m+[m[32m    row('Ответственный сейл-менеджер', managerName) +[m
[32m+[m[32m    row('Прибор', instrLabel) +[m
[32m+[m[32m    row('Локация', location) +[m
[32m+[m[32m    `\n🔗 <a href="${url}">Открыть заявку</a>` +[m
[32m+[m[32m    (dealUrl ? `\n⬆️ <a href="${dealUrl}">Открыть родительскую сделку</a>` : '');[m
[32m+[m
[32m+[m[32m  const emailRow = (label, val) => val ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:190px">${esc(label)}</td><td style="padding:6px 0;font-weight:600">${esc(val)}</td></tr>` : '';[m
[32m+[m[32m  const html = `[m
[32m+[m[32m    <div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto">[m
[32m+[m[32m      <div style="background:#0f6cbd;padding:18px 22px;border-radius:10px 10px 0 0">[m
[32m+[m[32m        <h2 style="color:#fff;margin:0;font-size:17px">🔧 ${esc(headerText)}</h2>[m
[32m+[m[32m        <p style="color:rgba(255,255,255,.85);margin:4px 0 0;font-size:13px">Заявка на сервис #${itemId}</p>[m
[32m+[m[32m      </div>[m
[32m+[m[32m      <div style="background:#fff;border:1px solid #e3e6ef;border-top:none;padding:22px;border-radius:0 0 10px 10px">[m
[32m+[m[32m        <table style="width:100%;border-collapse:collapse">[m
[32m+[m[32m          <tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:190px">Заявка</td><td style="padding:6px 0;font-weight:600">#${itemId} — ${esc(cleanTitle)}</td></tr>[m
[32m+[m[32m          ${emailRow('Тип оказываемых услуг', svcLabel)}[m
[32m+[m[32m          ${emailRow('Ответственный инженер', engineerName)}[m
[32m+[m[32m          ${emailRow('Дата назначения', assignDate)}[m
[32m+[m[32m          ${emailRow('Дата начала работ', startDate)}[m
[32m+[m[32m          ${emailRow('Дата завершения работ', endDate)}[m
[32m+[m[32m          ${emailRow('Клиент / Компания', clientName)}[m
[32m+[m[32m          ${emailRow('Контракт', contractLabel)}[m
[32m+[m[32m          ${emailRow('Ответственный сейл-менеджер', managerName)}[m
[32m+[m[32m          ${emailRow('Название прибора', instrLabel)}[m
[32m+[m[32m          ${emailRow('Локация', location)}[m
[32m+[m[32m        </table>[m
[32m+[m[32m        <div style="margin-top:18px">[m
[32m+[m[32m          <a href="${url}" style="background:#0f6cbd;color:#fff;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px">Открыть заявку</a>[m
[32m+[m[32m          ${dealUrl ? `<a href="${dealUrl}" style="background:#fff;border:1px solid #d2d0ce;color:#201f1e;padding:9px 18px;border-radius:8px;text-decoration:none;font-weight:600;font-size:13px;margin-left:8px">Открыть сделку</a>` : ''}[m
[32m+[m[32m        </div>[m
[32m+[m[32m      </div>[m
[32m+[m[32m      <p style="color:#9ca3af;font-size:11.5px;text-align:center;margin-top:14px">ProLabSupport Service Dashboard</p>[m
[32m+[m[32m    </div>`;[m
[32m+[m
[32m+[m[32m  const recipients = [...new Set([engineerId, managerId].filter(Boolean))];[m
[32m+[m[32m  for (const uid of recipients) {[m
[32m+[m[32m    await sendPersonalTg(uid, tgText);[m
[32m+[m[32m    await sendPersonalEmail(uid, `🔧 ${headerText}: заявка #${itemId}`, html);[m
[32m+[m[32m  }[m
[32m+[m[32m}[m
[32m+[m
 function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }[m
 [m
 module.exports = {[m
   setPool, getManagerTelegramChatId, sendPersonalTg, sendPersonalEmail,[m
[31m-  notifyProcessCompleted, notifyEngineerAssigned,[m
[32m+[m[32m  notifyProcessCompleted, notifyEngineerAssigned, notifyJobAssigned,[m
 };[m

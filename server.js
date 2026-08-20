require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
// Validate required env at startup
const REQUIRED = ['BITRIX_WEBHOOK','TG_TOKEN','TG_OPS_CHAT','TG_MGT_CHAT','JWT_SECRET','DATABASE_URL','ADMIN_USERNAME','ADMIN_PASSWORD','RESEND_API_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) { console.error(`❌ Missing env: ${key}`); process.exit(1); }
}
const { b24, flattenInto } = require('./bitrix');
const { initDB, requireAuth, requirePageAuth, requireModule, auditLog, canEdit, canDelete, pool } = require('./auth');
const { tgMgt, tgOps, tgBoth, notifyNewTicket, notifyOverdueNew } = require('./notifications');
const telegramLinkBot = require('./telegram-link-bot');
const equipmentRoutes = require('./routes/equipment-routes');
const { USERS, SERVICE_TYPES, COORDINATORS } = require('./constants');
const app = express();
const PORT = process.env.PORT || 3000;
const ENTITY_TYPE_ID = 1058;
const CATEGORY_ID = 11;
// ── Security middleware ────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));
// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60000, max: 120,
  standardHeaders: true, legacyHeaders: false,
  skip: (req) => req.path === '/api/health',
});
const authLimiter = rateLimit({
  windowMs: 60000, max: 30,
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/', apiLimiter);
app.use('/auth/login', authLimiter);
app.use('/auth/totp', authLimiter);
// Крупные загрузки (файлы закупок, ТТН) парсит РОУТ-специфичный express.json
// (45–90 МБ). Глобальный лимит 1 МБ иначе режет их 413-й до роутов — на iOS это
// всплывает как «The string did not match the expected pattern». Пропускаем их.
const _globalJson = express.json({ limit: '1mb' });
const _bigUploadRe = /\/(files|files-batch|ship-close|ship-file)$/;
app.use((req, res, next) => {
  if (req.method === 'POST' && _bigUploadRe.test(req.path)) return next();
  return _globalJson(req, res, next);
});
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// ── PWA: делаем дашборд устанавливаемым приложением на телефоне ──────────────
// Патчим res.sendFile так, чтобы в КАЖДУЮ html-страницу (все они отдаются через
// sendFile после проверки авторизации) автоматически подставлялись манифест,
// иконки и регистрация service worker. Правим один раз здесь — не 19 файлов.
const fs = require('fs');
const PWA_HEAD = [
  '<link rel="manifest" href="/manifest.webmanifest">',
  '<meta name="theme-color" content="#14171d">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
  '<meta name="apple-mobile-web-app-title" content="ЦУП">',
  '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">',
  "<script>if('serviceWorker' in navigator){addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}</script>",
  // Тема: инлайн-скрипт ставит атрибут ДО отрисовки (без мигания), затем CSS и кнопка-переключатель.
  "<script>(function(){try{if(localStorage.getItem('pls-theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}})();</script>",
  '<link rel="stylesheet" href="/assets/theme.css">',
  '<script src="/assets/theme.js" defer></script>',
  // Бейдж на иконке приложения (число действий пользователя) — см. assets/badge.js.
  '<script src="/assets/badge.js" defer></script>',
].join('\n') + '\n';
app.use((req, res, next) => {
  const orig = res.sendFile.bind(res);
  res.sendFile = (fp, opts, cb) => {
    if (typeof fp === 'string' && fp.endsWith('.html')) {
      fs.readFile(fp, 'utf8', (err, html) => {
        if (err) return orig(fp, opts, cb);
        let out = html;
        if (out.includes('</head>') && !out.includes('/manifest.webmanifest')) out = out.replace('</head>', PWA_HEAD + '</head>');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(out);
      });
      return;
    }
    return orig(fp, opts, cb);
  };
  next();
});

// ── Page routes — MUST be registered before express.static, or static's
// default file-serving would hand out these pages to anyone, auth or not. ──
// Public-facing subdomains for client-facing forms — no auth, any path.
// Must come before the auth-gated routes below.
app.use((req, res, next) => {
  if (req.hostname === 'service.prolabsupport.kz') {
    return res.sendFile(path.join(__dirname, 'public', 'service-redirect.html'));
  }
  if (req.hostname === 'feedback.prolabsupport.kz') {
    return res.sendFile(path.join(__dirname, 'public', 'feedback-redirect.html'));
  }
  if (req.hostname === 'review.prolabsupport.kz') {
    return res.sendFile(path.join(__dirname, 'public', 'review-redirect.html'));
  }
  next();
});
app.get('/login', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/login.html', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/', requirePageAuth(), (_, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));
app.get('/portal.html', requirePageAuth(), (_, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));
// Доступ к модулям — ПО ВЫДАННЫМ ГРАНТАМ (requireModule), а не по роли: кому
// выдан модуль, тот может его открыть (в т.ч. viewer — в режиме просмотра).
// admin видит всё. Роль дальше определяет право правки/удаления внутри модуля.
app.get('/index.html', requireModule('SVC'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/planner.html', requireModule('PLN'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'planner.html')));
app.get('/equipment-map.html', requireModule('EQP'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'equipment-map.html')));
app.get('/licenses-map.html', requireModule('LIC'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'licenses-map.html')));
app.get('/relations.html', requireModule('REL'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'relations.html')));
app.get('/admin.html', requirePageAuth(['admin']), (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/mail.html', requireModule('MAIL'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'mail.html')));
app.get('/kp.html', requireModule('KP'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'kp.html')));
app.get('/bonus.html', requireModule('BONUS'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'bonus.html')));
app.get('/stats.html', requireModule('STATS'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));
app.get('/contracts.html', requireModule('CONTR'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'contracts.html')));
app.get('/logistics.html', requireModule('LOG'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'logistics.html')));
app.get('/operational.html', requireModule('OPS'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'operational.html')));
app.get('/procurement.html', requireModule('PROC'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'procurement.html')));
app.get('/campaigns.html', requireModule('CAM'), (_, res) => res.sendFile(path.join(__dirname, 'public', 'campaigns.html')));
app.get('/cup-admin.html', requirePageAuth(['admin']), (_, res) => res.sendFile(path.join(__dirname, 'public', 'cup-admin.html')));
app.get('/account.html', requirePageAuth(), (_, res) => res.sendFile(path.join(__dirname, 'public', 'account.html')));
// `index:false` — without this, static would auto-serve public/index.html
// for "/" and silently undo everything above.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth-routes'));
app.use('/admin', require('./routes/admin-routes'));
app.use('/api/account', require('./routes/account-routes'));
equipmentRoutes.setB24(b24);
app.use('/equipment', equipmentRoutes.router);
app.use('/licenses', require('./routes/licenses-routes'));
app.use('/api/planner', require('./routes/planner-routes').router);
app.use('/api/mail', require('./routes/mail-routes').router);
app.use('/api/kp', require('./routes/kp-routes').router);
app.use('/api/bonus', require('./routes/bonus-routes').router);
app.use('/api/stats', require('./routes/stats-routes').router);
app.use('/api/contracts', require('./routes/contracts-routes').router);
app.use('/api/logistics', require('./routes/logistics-routes').router);
app.use('/api/operational', require('./routes/operational-routes').router);
app.use('/api/procurement', require('./routes/procurement-routes').router);
app.use('/api/campaigns', require('./routes/campaigns-routes').router);
app.use('/api/notify', require('./routes/notify-routes').router);
const { router: relationsRouter, handleBitrixWebhook } = require('./routes/relations-routes');
app.use('/relations', relationsRouter);
app.post('/webhook/bitrix-update', express.urlencoded({ extended: true }), handleBitrixWebhook);
app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
// ── Config ────────────────────────────────────────────────────────────────────
const STAGES = {
  'DT1058_11:UC_N8RQ0V': { name:'Заявки клиентов',      color:'#468ee5', order:0, active:true },
  'DT1058_11:NEW':        { name:'Необработанные',       color:'#22B9FF', order:1, active:true },
  'DT1058_11:PREPARATION':{ name:'Досбор / Назначение',  color:'#88B9FF', order:2, active:true },
  'DT1058_11:CLIENT':     { name:'Заявка в работе',      color:'#10e5fc', order:3, active:true },
  'DT1058_11:1':          { name:'Срочная в работе',     color:'#FF6B35', order:4, active:true },
  'DT1058_11:2':          { name:'Заявка на обучение',   color:'#9B59B6', order:5, active:true },
  'DT1058_11:3':          { name:'Заявка исполнена',     color:'#55D0E0', order:6, active:true },
  'DT1058_11:4':          { name:'Претензия',            color:'#FF5752', order:7, active:true },
  'DT1058_11:SUCCESS':    { name:'Заявка закрыта',       color:'#00C851', order:8, active:false },
  'DT1058_11:FAIL':       { name:'Заявка отменена',      color:'#ff4444', order:9, active:false },
};
const COORDINATOR_STAGES = new Set(['DT1058_11:NEW','DT1058_11:PREPARATION']);
const URGENCY_MAP = {'1809':'Срочная','1810':'Не срочная','1811':'Обучение ТЦ'};
const NEW_ENTRY_STAGES = ['DT1058_11:UC_N8RQ0V','DT1058_11:NEW'];
const PRESET_SVC = {
  tickets: new Set(['619']),
  docs: new Set(['402','111']),
  obligations: new Set(['103','104','105','106','108','109','110','114']),
};
// "E-mail (CRM форма)" — client email captured when the CRM webform is
// submitted. Confirmed via find-ticket-email-field.js against ticket #1701.
const CLIENT_EMAIL_FIELD = 'ufCrm8_1766050253061';
function enrichItem(t) {
  const uid = t.assignedById;
  const userName = USERS[uid] || `Пользователь ${uid}`;
  const isCoordUser = COORDINATORS.has(uid);
  const isCoordStage = COORDINATOR_STAGES.has(t.stageId);
  const svcIds = Array.isArray(t.ufCrm8_1744300223)
    ? t.ufCrm8_1744300223.map(String)
    : t.ufCrm8_1744300223 ? [String(t.ufCrm8_1744300223)] : [];
  const clientEmailRaw = t[CLIENT_EMAIL_FIELD];
  const clientEmail = Array.isArray(clientEmailRaw) ? (clientEmailRaw[0] || null) : (clientEmailRaw || null);
  return {
    id: t.id,
    title: t.title || '—',
    stageId: t.stageId,
    stageName: STAGES[t.stageId]?.name || t.stageId,
    stageColor: STAGES[t.stageId]?.color || '#ccc',
    isActive: STAGES[t.stageId]?.active ?? true,
    createdTime: t.createdTime,
    urgency: URGENCY_MAP[t.ufCrm8_1732856252874] || null,
    isOverdue: t.ufCrm8_1732856215147 === '1807',
    coordinator: isCoordUser ? userName : null,
    engineer: (!isCoordUser && !isCoordStage) ? userName : null,
    serviceTypes: svcIds.map(id => SERVICE_TYPES[id] || `Тип ${id}`),
    serviceTypeIds: svcIds,
    description: t.ufCrm8_1760688207256 || t.ufCrm8_1732855669306 || null,
    comment: t.ufCrm8_1732856926809 || null,
    movedTime: t.movedTime || null,
    daysOnStage: t.movedTime ? Math.floor((Date.now() - new Date(t.movedTime)) / 86400000) : null,
    clientEmail,
    bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/details/${t.id}/`,
  };
}
// ── GET /api/tickets ──────────────────────────────────────────────────────────
app.get('/api/tickets', requireAuth(), async (req, res) => {
  try {
    const { urgent, overdue, search, engineer, coordinator, serviceType, presetSvcTypes, stageFilter } = req.query;
    const filter = { categoryId: CATEGORY_ID };
    filter.stageId = Object.entries(STAGES).filter(([,v]) => v.active).map(([k]) => k);
    if (stageFilter && stageFilter !== 'all') filter.stageId = [stageFilter];
    if (urgent && urgent !== 'all') filter['ufCrm8_1732856252874'] = urgent;
    if (overdue === 'yes') filter['ufCrm8_1732856215147'] = '1807';
    if (serviceType && serviceType !== 'all') filter['ufCrm8_1744300223'] = serviceType;
    let items = [], start = 0, total = Infinity;
    while (items.length < Math.min(total, 500)) {
      const data = await b24('crm.item.list', {
        entityTypeId: ENTITY_TYPE_ID, filter,
        select: ['id','title','stageId','createdTime','assignedById',
          'ufCrm8_1744300223','ufCrm8_1732856252874','ufCrm8_1732856215147',
          'ufCrm8_1760688207256','ufCrm8_1732855669306','ufCrm8_1732856926809','movedTime',
          CLIENT_EMAIL_FIELD],
        order: { createdTime: 'DESC' }, start,
      });
      if (!data.result?.items?.length) break;
      items = items.concat(data.result.items);
      total = data.total ?? items.length;
      start = items.length;
      if (!data.next || items.length >= total) break;
    }
    const engineerSet = new Set(), coordSet = new Set();
    let enriched = items.map(t => {
      const e = enrichItem(t);
      if (e.engineer) engineerSet.add(e.engineer);
      if (e.coordinator) coordSet.add(e.coordinator);
      return e;
    });
    if (engineer && engineer !== 'all') enriched = enriched.filter(t => t.engineer === engineer);
    if (coordinator && coordinator !== 'all') enriched = enriched.filter(t => t.coordinator === coordinator);
    if (presetSvcTypes && presetSvcTypes !== '') {
      const allowed = new Set(presetSvcTypes.split(',').map(s => s.trim()));
      enriched = enriched.filter(t => t.serviceTypeIds.some(id => allowed.has(id)));
    }
    if (search?.trim()) {
      const q = search.toLowerCase();
      enriched = enriched.filter(t =>
        (t.title||'').toLowerCase().includes(q) ||
        (t.description||'').toLowerCase().includes(q) ||
        (t.engineer||'').toLowerCase().includes(q) ||
        (t.coordinator||'').toLowerCase().includes(q)
      );
    }
    const allEnriched = items.map(t => enrichItem(t));
    const presetCounts = { all: allEnriched.length };
    for (const [key, svcSet] of Object.entries(PRESET_SVC)) {
      presetCounts[key] = allEnriched.filter(t => t.serviceTypeIds.some(id => svcSet.has(id))).length;
    }
    presetCounts.overdue = allEnriched.filter(t => t.isOverdue).length;
    const stats = {
      total: enriched.length,
      urgent: enriched.filter(t => t.urgency === 'Срочная').length,
      overdue: enriched.filter(t => t.isOverdue).length,
      byStage: Object.fromEntries(Object.entries(STAGES).map(([sid, cfg]) => [
        sid, { name: cfg.name, color: cfg.color, count: enriched.filter(t => t.stageId === sid).length }
      ])),
    };
    res.json({
      ok: true, items: enriched, stats, stages: STAGES,
      engineers: [...engineerSet].sort(),
      coordinators: [...coordSet].sort(),
      serviceTypes: SERVICE_TYPES,
      presetCounts,
      currentUser: { role: req.user.role, engineerName: req.user.engineer_name, displayName: req.user.display_name },
    });
  } catch(err) {
    console.error('/api/tickets error:', err.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});
// ── POST /api/comment ─────────────────────────────────────────────────────────
// ── Переписка с клиентом (Написать клиенту) ────────────────────────────────
app.post('/api/settings/app-password', requireAuth(['admin','coordinator','engineer']), async (req, res) => {
  try {
    const { appPassword } = req.body;
    if (!appPassword) return res.status(400).json({ ok: false, error: 'Пароль не указан' });
    const { encrypt } = require('./crypto-helper');
    await pool.query('UPDATE ticketsmodule_users SET smtp_app_password_encrypted=$1 WHERE id=$2', [encrypt(appPassword), req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/settings/app-password error:', e.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});
app.get('/api/settings/app-password/status', requireAuth(['admin','coordinator','engineer']), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT smtp_app_password_encrypted IS NOT NULL AS configured, job_title, mobile_phone FROM ticketsmodule_users WHERE id=$1', [req.user.id]);
    res.json({ configured: rows[0]?.configured || false, jobTitle: rows[0]?.job_title || '', mobilePhone: rows[0]?.mobile_phone || '' });
  } catch (e) {
    res.status(500).json({ configured: false });
  }
});
app.post('/api/settings/signature', requireAuth(['admin','coordinator','engineer']), async (req, res) => {
  try {
    const { jobTitle, mobilePhone } = req.body;
    await pool.query('UPDATE ticketsmodule_users SET job_title=$1, mobile_phone=$2 WHERE id=$3', [jobTitle || null, mobilePhone || null, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/settings/signature error:', e.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});
app.post('/api/ticket-email/send', requireAuth(['admin','coordinator','engineer','manager','logist']), async (req, res) => {
  try {
    const { ticketId, to, cc, subject, bodyHtml } = req.body;
    if (!ticketId || !to || !subject || !bodyHtml) return res.status(400).json({ ok: false, error: 'Заполните все поля' });
    if (!req.user.username.includes('@')) return res.status(400).json({ ok: false, error: 'Ваш логин должен быть корпоративной почтой для отправки писем' });
    const { sendTicketEmail } = require('./ticket-mail');
    await sendTicketEmail({
      ticketId, engineerUserId: req.user.id, engineerEmail: req.user.username,
      engineerName: req.user.display_name, to, cc, subject, bodyHtml,
    });
    await b24('crm.timeline.comment.add', {
      fields: { ENTITY_ID: ticketId, ENTITY_TYPE: 'dynamic_1058', COMMENT: `📧 ${req.user.display_name} → ${to}\n${subject}\n\n${bodyHtml}` }
    }).catch(() => {});
    await auditLog(req.user.id, req.user.username, 'CLIENT_EMAIL_SENT', ticketId, { to, subject }, req.headers['x-forwarded-for'] || req.ip, req.headers['user-agent']);
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/ticket-email/send error:', e.message);
    res.status(500).json({ ok: false, error: e.message || 'Не удалось отправить письмо' });
  }
});
app.post('/api/ticket-email/poll-now', requireAuth(['admin','coordinator','engineer','manager','logist']), async (req, res) => {
  try {
    const { pollTicketMailbox } = require('./ticket-mail-poller');
    await pollTicketMailbox();
    res.json({ ok: true });
  } catch (e) {
    console.error('/api/ticket-email/poll-now error:', e.message);
    res.status(500).json({ ok: false, error: 'Не удалось проверить почту' });
  }
});
app.get('/api/ticket-email/:ticketId', requireAuth(['admin','coordinator','engineer','manager','logist','viewer']), async (req, res) => {
  try {
    const { getTicketEmails } = require('./ticket-mail');
    const emails = await getTicketEmails(req.params.ticketId);
    res.json({ emails });
  } catch (e) {
    console.error('/api/ticket-email/:ticketId error:', e.message);
    res.status(500).json({ emails: [] });
  }
});
app.post('/api/comment', requireAuth(['admin','coordinator','engineer','manager','logist']), async (req, res) => {
  try {
    const { ticketId, comment, stageId, engineerId, sendTg } = req.body;
    if (!ticketId) return res.status(400).json({ ok: false, error: 'Не указан ID заявки' });
    const authorName = req.user.display_name;
    const ip = req.headers['x-forwarded-for'] || req.ip;
    if (req.user.role === 'engineer') {
      const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId });
      const t = enrichItem(data.result?.item || {});
      if (!canEdit(req.user, t)) return res.status(403).json({ ok: false, error: 'Нет прав на редактирование этой заявки' });
    }
    const fields = {};
    if (comment) fields['ufCrm8_1732856926809'] = comment;
    if (stageId) fields.stageId = stageId;
    if (engineerId) fields.assignedById = engineerId;
    if (Object.keys(fields).length > 0) {
      await b24('crm.item.update', { entityTypeId: ENTITY_TYPE_ID, id: ticketId, fields });
    }
    if (comment) {
      await b24('crm.timeline.comment.add', {
        fields: { ENTITY_ID: ticketId, ENTITY_TYPE: 'dynamic_1058', COMMENT: `💬 ${authorName}: ${comment}` }
      }).catch(() => {});
    }
    if (comment) await auditLog(req.user.id, req.user.username, 'COMMENT_ADDED', ticketId, { comment: comment.slice(0,100) }, ip, req.headers['user-agent']);
    if (stageId) await auditLog(req.user.id, req.user.username, 'STAGE_CHANGED', ticketId, { to: STAGES[stageId]?.name || stageId }, ip, req.headers['user-agent']);
    if (engineerId) await auditLog(req.user.id, req.user.username, 'ENGINEER_ASSIGNED', ticketId, { engineer: USERS[engineerId] || engineerId }, ip, req.headers['user-agent']);
    if (sendTg !== false) {
      const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId })
        .catch(() => ({ result: { item: { id: ticketId, title: '', stageId: '' } } }));
      const t = enrichItem(data.result?.item || { id: ticketId, title: '', stageId: '' });
      const cleanTitle = (t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim() || `Заявка #${ticketId}`;
      const sc = stageId ? `\n📌 Стадия → <b>${STAGES[stageId]?.name || stageId}</b>` : '';
      const ec = engineerId ? `\n👤 Инженер → <b>${USERS[engineerId] || engineerId}</b>` : '';
      const cc = comment ? `\n💬 <b>${authorName}:</b> ${comment}` : '';
      await tgBoth(`✏️ <b>Обновление заявки #${ticketId}</b>\n📋 ${cleanTitle}${sc}${ec}${cc}\n🔗 <a href="${t.bitrixUrl}">Открыть в Битрикс24</a>`);
    }
    res.json({ ok: true });
  } catch(err) {
    console.error('/api/comment error:', err.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});
// ── POST /api/remind ──────────────────────────────────────────────────────────
app.post('/api/remind', requireAuth(['admin','coordinator','manager','logist']), async (req, res) => {
  try {
    const { ticketId, message, delayMinutes, targetChat, sendTg } = req.body;
    if (!ticketId) return res.status(400).json({ ok: false, error: 'Не указан ID заявки' });
    const authorName = req.user.display_name;
    const ip = req.headers['x-forwarded-for'] || req.ip;
    const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId })
      .catch(() => ({ result: { item: { id: ticketId, title: '', stageId: '' } } }));
    const t = enrichItem(data.result?.item || { id: ticketId, title: '', stageId: '' });
    const cleanTitle = (t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim() || `Заявка #${ticketId}`;
    const sendReminder = async () => {
      const tgText = `🔔 <b>Напоминание по заявке #${ticketId}</b>\n📋 ${cleanTitle}\n${message ? `📝 ${message}\n` : ''}👤 От: ${authorName}\n🔗 <a href="${t.bitrixUrl}">Открыть в Битрикс24</a>`;
      if (targetChat === 'mgt') await tgMgt(tgText);
      else if (targetChat === 'both') await tgBoth(tgText);
      else await tgOps(tgText);
    };
    const delay = Math.max(0, Math.min(parseInt(delayMinutes) || 0, 1440)) * 60000;
    if (delay > 0) setTimeout(sendReminder, delay);
    else if (sendTg !== false) await sendReminder();
    await auditLog(req.user.id, req.user.username, 'REMIND_SENT', ticketId, { delay: delayMinutes, chat: targetChat }, ip, req.headers['user-agent']);
    res.json({ ok: true, scheduledIn: delay / 60000 });
  } catch(err) {
    console.error('/api/remind error:', err.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});
// ── POST /api/task ────────────────────────────────────────────────────────────
app.post('/api/task', requireAuth(['admin','coordinator','manager','logist']), async (req, res) => {
  try {
    const { ticketId, taskTitle, taskDesc, responsibleId, deadline, sendTg } = req.body;
    if (!ticketId) return res.status(400).json({ ok: false, error: 'Не указан ID заявки' });
    const authorName = req.user.display_name;
    const ip = req.headers['x-forwarded-for'] || req.ip;
    const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId })
      .catch(() => ({ result: { item: { id: ticketId, title: '', stageId: '' } } }));
    const t = enrichItem(data.result?.item || { id: ticketId, title: '', stageId: '' });
    const cleanTitle = (t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim() || `Заявка #${ticketId}`;
    const taskData = await b24('tasks.task.add', { fields: {
      TITLE: taskTitle || cleanTitle.slice(0, 100),
      DESCRIPTION: taskDesc || '',
      RESPONSIBLE_ID: responsibleId || 26,
      DEADLINE: deadline || '',
      UF_CRM_TASK: [`D_${ENTITY_TYPE_ID}_${ticketId}`],
    }});
    const taskId = taskData.result?.task?.id;
    await auditLog(req.user.id, req.user.username, 'TASK_CREATED', ticketId, { taskId, taskTitle, responsibleId: USERS[responsibleId] || responsibleId }, ip, req.headers['user-agent']);
    if (sendTg !== false) {
      await tgBoth(`📋 <b>Создана задача в Битрикс24</b>\n🎫 Заявка #${ticketId}: ${cleanTitle}\n📝 ${taskTitle || 'Без названия'}\n${deadline ? `⏰ Дедлайн: ${new Date(deadline).toLocaleDateString('ru')}\n` : ''}👤 Ответственный: ${USERS[responsibleId] || '—'}\n👤 Создал: ${authorName}\n🔗 <a href="${t.bitrixUrl}">Открыть заявку</a>`);
    }
    res.json({ ok: true, taskId });
  } catch(err) {
    console.error('/api/task error:', err.message);
    res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
  }
});
// ── GET /api/users ────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth(), (_, res) => {
  const engineers = Object.entries(USERS)
    .filter(([id]) => !COORDINATORS.has(Number(id)) && Number(id) > 10)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  res.json({ ok: true, users: engineers, coordinators: [...COORDINATORS].map(id => ({ id, name: USERS[id] })) });
});
// GET /api/portal/my-access — which ЦУП modules the current user can see.
// Строгий режим: сотрудник видит ТОЛЬКО модули, явно выданные администратором
// («Доступ к модулям»), независимо от роли. Роль больше не даёт модули по умолчанию.
// Админ видит всё. Связка с Bitrix — по полю bitrix_user_id из карточки (надёжно),
// с фолбэком на совпадение по имени для старых учёток без явной привязки.
app.get('/api/portal/my-access', requireAuth(), async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.json({ ok: true, admin: true });
    let bitrixUserId = req.user.bitrix_user_id || null;
    if (!bitrixUserId && req.user.engineer_name) {
      const found = Object.entries(USERS).find(([, name]) => name === req.user.engineer_name);
      if (found) bitrixUserId = parseInt(found[0], 10);
    }
    if (!bitrixUserId) return res.json({ ok: true, enforced: true, modules: [] });
    const { rows } = await pool.query('SELECT modules FROM ticketsmodule_module_access WHERE bitrix_user_id=$1', [bitrixUserId]);
    const modules = rows.length ? (rows[0].modules || []) : [];
    res.json({ ok: true, enforced: true, modules });
  } catch (e) {
    console.error('GET /api/portal/my-access error:', e.message);
    // Строгий режим: при ошибке не раскрываем лишнего — только личный кабинет.
    res.json({ ok: true, enforced: true, modules: [] });
  }
});
// ── SPA fallback — must be LAST ───────────────────────────────────────────────
app.get('*', requirePageAuth(), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portal.html'));
});
// ── Background: check new & overdue tickets (single interval) ─────────────────
const notifiedNewTickets = new Set();
let lastKnownTicketIds = new Set();
let isFirstLoad = true;
async function fetchEntryStageTickets() {
  const enriched = [];
  for (const stageId of NEW_ENTRY_STAGES) {
    const data = await b24('crm.item.list', {
      entityTypeId: ENTITY_TYPE_ID,
      filter: { categoryId: CATEGORY_ID, stageId },
      select: ['id','title','stageId','createdTime','movedTime','assignedById',
        'ufCrm8_1744300223','ufCrm8_1732856252874','ufCrm8_1732856215147','ufCrm8_1760688207256'],
      order: { createdTime: 'DESC' },
      start: 0,
    });
    enriched.push(...(data.result?.items || []).map(t => enrichItem(t)));
  }
  return enriched;
}
async function checkNewAndOverdue() {
  try {
    const enriched = await fetchEntryStageTickets();
    const currentIds = new Set(enriched.map(t => t.id));
    if (!isFirstLoad) {
      for (const t of enriched) {
        if (!lastKnownTicketIds.has(t.id) && !notifiedNewTickets.has(t.id)) {
          notifiedNewTickets.add(t.id);
          await notifyNewTicket(t);
        }
      }
      // Clean up IDs that are no longer in entry stages (safe to remove)
      for (const id of notifiedNewTickets) {
        if (!currentIds.has(id)) notifiedNewTickets.delete(id);
      }
    } else {
      enriched.forEach(t => notifiedNewTickets.add(t.id));
      isFirstLoad = false;
    }
    lastKnownTicketIds = currentIds;
    // Clean DB: remove tickets that left entry stages
    if (currentIds.size > 0) {
      const ids = [...currentIds];
      await pool.query(
        `DELETE FROM ticketsmodule_notified_overdue WHERE ticket_id NOT IN (${ids.map((_,i) => `$${i+1}`).join(',')})`,
        ids
      ).catch(() => {});
    } else {
      await pool.query('DELETE FROM ticketsmodule_notified_overdue').catch(() => {});
    }
    // Overdue: notify only once (persisted in DB)
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const newlyOverdue = [];
    for (const t of enriched) {
      if (!t.movedTime || (Date.now() - new Date(t.movedTime)) <= EIGHT_HOURS) continue;
      const exists = await pool.query('SELECT 1 FROM ticketsmodule_notified_overdue WHERE ticket_id=$1', [t.id]);
      if (exists.rows.length === 0) newlyOverdue.push(t);
    }
    if (newlyOverdue.length > 0) {
      for (const t of newlyOverdue) {
        await pool.query('INSERT INTO ticketsmodule_notified_overdue (ticket_id) VALUES ($1) ON CONFLICT DO NOTHING', [t.id]);
      }
      await notifyOverdueNew(newlyOverdue);
    }
  } catch(e) {
    console.error('checkNewAndOverdue error:', e.message);
  }
}
// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Dashboard running on port ${PORT}`);
    // Глобально дозагружаем справочник сотрудников из Bitrix (чинит «#49/#66/#92»
    // во ВСЕХ модулях сразу — Логистика, Контракты, Реализация и т.д.).
    const { hydrateUsers } = require('./constants');
    setTimeout(() => hydrateUsers().catch(e => console.error('hydrateUsers boot error:', e.message)), 3000);
    // Single interval: check new tickets every 30 min + overdue every run
    checkNewAndOverdue();
    setInterval(checkNewAndOverdue, 30 * 60 * 1000);
    // USD/KZT exchange rate — refresh once on boot, then daily. Bonus
    // calculations read from the cache this keeps warm.
    const { refreshDailyRate } = require('./nbrk-exchange-rate');
    setTimeout(() => refreshDailyRate(), 5000);
    setInterval(() => refreshDailyRate(), 24 * 60 * 60 * 1000);
    // Статистика deals cache — полная сверка идёт НОЧЬЮ в 01:00 по Кызылорде
    // (в ночном блоке ниже, сразу после операционной сверки, чтобы не грузить
    // Битрикс двумя тяжёлыми прогонами одновременно). Живые точечные апдейты —
    // через тот же вебхук ONCRMDEALADD/UPDATE.
    const { fullSync: fullSyncStatsDeals } = require('./stats-sync');
    // Операционный модуль «Реализация»: кэш сделок исполнительной фазы. Один
    // полный прогон при старте (наполнить кэш после деплоя), затем ночная
    // сверка в 01:00 по Кызылорде (UTC+5) = 20:00 UTC. Живые точечные апдейты
    // приходят через вебхук ONCRMDEALADD/UPDATE (см. relations-routes).
    const { fullSync: operationalFullSync, isSyncing: opIsSyncing } = require('./operational-sync');
    const { getSyncMeta: getOpSyncMeta } = require('./operational');
    setTimeout(() => operationalFullSync({ source: 'boot' }).catch(e => console.error('operational boot sync error:', e.message)), 20000);
    // Авто-рассылка операционного отчёта руководству (вт 18:00 Алматы = 13:00 UTC).
    try { require('./ops-report-scheduler').startOpsReportScheduler(); } catch (e) { console.error('ops-report scheduler start error:', e.message); }
    // Логистика: считается тяжело (~1 мин), поэтому НЕ на каждый заход страницы, а
    // в фоне — прогрев кэша на старте + освежение раз в час. Страница отдаёт кэш
    // мгновенно; кнопка «Обновить» пересчитывает по требованию.
    const { refreshBoard: refreshLogistics } = require('./logistics-calc');
    const { runLogisticsAlerts } = require('./logistics-notify');
    const refreshAndAlert = tag => refreshLogistics()
      .then(() => runLogisticsAlerts())
      .catch(e => console.error(`logistics ${tag} refresh/alert error:`, e.message));
    setTimeout(() => refreshAndAlert('boot'), 25000);
    setInterval(() => refreshAndAlert('hourly'), 60 * 60 * 1000);
    // Карта оборудования: кэш в БД, карта открывается мгновенно. Поднимаем кэш из
    // БД на старте; если пусто — полная сборка в фоне.
    setTimeout(() => equipmentRoutes.bootPreload().catch(e => console.error('equipment bootPreload error:', e.message)), 30000);
    let lastOpSyncDate = null, lastEquipSyncDate = null, lastOpCatchup = 0;
    setInterval(async () => {
      const now = new Date();
      const dateKey = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === 20 && lastOpSyncDate !== dateKey) {
        lastOpSyncDate = dateKey;
        // 01:00 Кызылорда, последовательно (чтобы не долбить Битрикс разом):
        // операционная сверка → статистика → полный пересбор логистики.
        operationalFullSync({ source: 'nightly' })
          .catch(e => console.error('operational nightly sync error:', e.message))
          .then(() => fullSyncStatsDeals().catch(e => console.error('stats nightly sync error:', e.message)))
          .then(() => refreshAndAlert('nightly'));
      }
      // ── Самолечение «Реализации» ─────────────────────────────────────────────
      // Ночной синк — процессный setInterval: если контейнер в 20:00 UTC спал/
      // рестартился ИЛИ сверка упала, данные «замирали» (как встали на 11-м).
      // Догоняем автоматически: последняя УСПЕШНАЯ сверка старше 24ч и синк не
      // идёт → запускаем (не чаще раза в 25 мин, чтобы не спамить при сбое).
      try {
        const meta = await getOpSyncMeta();
        const okAt = meta.lastOkAt || meta.lastFullSync;
        const ageH = okAt ? (Date.now() - new Date(okAt).getTime()) / 3600000 : Infinity;
        if (ageH > 24 && !opIsSyncing() && Date.now() - lastOpCatchup > 25 * 60 * 1000) {
          lastOpCatchup = Date.now();
          console.log(`operational: данные старше ${Math.round(ageH)}ч — запускаю догоняющую сверку`);
          operationalFullSync({ source: 'catchup' }).catch(e => console.error('operational catchup error:', e.message));
        }
      } catch (e) { /* мета недоступна — пропускаем */ }
      // 03:00 Алматы (UTC+5) = 22:00 UTC — полная сборка Карты оборудования + геокодирование.
      if (now.getUTCHours() === 22 && lastEquipSyncDate !== dateKey) {
        lastEquipSyncDate = dateKey;
        equipmentRoutes.nightlyFullSync().catch(e => console.error('equipment nightly full sync error:', e.message));
      }
    }, 5 * 60 * 1000);
    // Planner ↔ Bitrix reconciliation — webhooks are best-effort, this catches
    // anything a missed/failed webhook delivery would otherwise leave stale.
    const { reconcileAllPlannerEvents } = require('./routes/relations-routes');
    setTimeout(() => reconcileAllPlannerEvents().catch(e => console.error('reconcileAllPlannerEvents error:', e.message)), 10000);
    setInterval(() => reconcileAllPlannerEvents().catch(e => console.error('reconcileAllPlannerEvents error:', e.message)), 10 * 60 * 1000);
    // Fallback авто-создания закупок из завершённых подборов (если вебхук из Bitrix
    // не доходит). Дедуп по source_item_id — повторных закупок не будет.
    try {
      const { scanServiceForAutoCreate } = require('./procurement-calc');
      setTimeout(() => scanServiceForAutoCreate().catch(e => console.error('procurement scan boot error:', e.message)), 45000);
      setInterval(() => scanServiceForAutoCreate().catch(e => console.error('procurement scan error:', e.message)), 15 * 60 * 1000);
    } catch (e) { console.error('procurement scan init error:', e.message); }
    // Пуши/бейджи: пересчёт числа действий у подписанных пользователей и тихое
    // обновление бейджа на иконке приложения (работает даже когда оно закрыто).
    try {
      const push = require('./push');
      if (push.enabled()) {
        setTimeout(() => push.broadcastBadges().catch(e => console.error('push broadcastBadges boot error:', e.message)), 20000);
        setInterval(() => push.broadcastBadges().catch(e => console.error('push broadcastBadges error:', e.message)), 3 * 60 * 1000);
        console.log('✅ Web Push (бейджи на иконке) активны');
      }
    } catch (e) { console.error('push init error:', e.message); }
    // Telegram linking bot
    telegramLinkBot.setPool(pool);
    telegramLinkBot.startPolling(15000);
    console.log('✅ Telegram link bot started');
    // Mail tracker: poll inbox, alert on unanswered client emails, daily digest/report
    const { pollInbox } = require('./mail-poller');
    const mailLib = require('./mail-lib');
    const { notifyPendingEmails, sendDailyDigest } = require('./mail-telegram');
    const { sendEmailReport } = require('./mail-mailer');
    const MAIL_ALERT_AFTER = parseInt(process.env.MAIL_ALERT_AFTER_MINUTES || '60');
    const MAIL_POLL_INTERVAL = parseInt(process.env.MAIL_POLL_INTERVAL_MINUTES || '3');
    pollInbox().catch(e => console.error('mail pollInbox error:', e.message));
    setInterval(() => pollInbox().catch(e => console.error('mail pollInbox error:', e.message)), MAIL_POLL_INTERVAL * 60 * 1000);
    // Client reply catcher for "Написать клиенту" — polls the Yandex 360
    // lost-mail catch-all inbox for replies to svc-{ticketId}@ addresses.
    const { pollTicketMailbox } = require('./ticket-mail-poller');
    const TICKET_MAIL_POLL_INTERVAL = parseInt(process.env.TICKET_MAIL_POLL_INTERVAL_MINUTES || '3');
    pollTicketMailbox().catch(e => console.error('ticket-mail pollTicketMailbox error:', e.message));
    setInterval(() => pollTicketMailbox().catch(e => console.error('ticket-mail pollTicketMailbox error:', e.message)), TICKET_MAIL_POLL_INTERVAL * 60 * 1000);
    setInterval(async () => {
      try {
        const pending = await mailLib.getUnnotified(MAIL_ALERT_AFTER);
        if (pending.length > 0) {
          await notifyPendingEmails(pending);
          for (const e of pending) await mailLib.markNotified(e.id);
        }
      } catch (e) { console.error('mail unanswered-check error:', e.message); }
    }, 15 * 60 * 1000);
    // Daily digest at 04:00 and 13:00 UTC (~09:00 and 18:00 Almaty)
    let lastDigestHour = null;
    setInterval(async () => {
      const h = new Date().getUTCHours();
      if ((h === 4 || h === 13) && lastDigestHour !== h) {
        lastDigestHour = h;
        try { await sendDailyDigest(await mailLib.getStats()); } catch (e) { console.error('mail daily digest error:', e.message); }
      }
    }, 5 * 60 * 1000);
    // Daily email report at 13:00 UTC (18:00 Almaty)
    let lastReportDate = null;
    setInterval(async () => {
      const now = new Date();
      const dateKey = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === 13 && lastReportDate !== dateKey) {
        lastReportDate = dateKey;
        try {
          const stats = await mailLib.getStats();
          const pending = await mailLib.getPendingEmails();
          await sendEmailReport(stats, pending);
        } catch (e) { console.error('mail daily report error:', e.message); }
      }
    }, 5 * 60 * 1000);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

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
const { initDB, requireAuth, auditLog, canEdit, pool } = require('./auth');
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

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth-routes'));
app.use('/admin', require('./routes/admin-routes'));
equipmentRoutes.setB24(b24);
app.use('/equipment', equipmentRoutes.router);
app.use('/licenses', require('./routes/licenses-routes'));
const { router: relationsRouter, handleBitrixWebhook } = require('./routes/relations-routes');
app.use('/relations', relationsRouter);
app.post('/webhook/bitrix-update', express.urlencoded({ extended: true }), handleBitrixWebhook);

app.get('/login', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/', requireAuth(), (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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

function enrichItem(t) {
  const uid = t.assignedById;
  const userName = USERS[uid] || `Пользователь ${uid}`;
  const isCoordUser = COORDINATORS.has(uid);
  const isCoordStage = COORDINATOR_STAGES.has(t.stageId);
  const svcIds = Array.isArray(t.ufCrm8_1744300223)
    ? t.ufCrm8_1744300223.map(String)
    : t.ufCrm8_1744300223 ? [String(t.ufCrm8_1744300223)] : [];
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
          'ufCrm8_1760688207256','ufCrm8_1732855669306','ufCrm8_1732856926809','movedTime'],
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
app.post('/api/comment', requireAuth(['admin','coordinator','engineer']), async (req, res) => {
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
app.post('/api/remind', requireAuth(['admin','coordinator']), async (req, res) => {
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
app.post('/api/task', requireAuth(['admin','coordinator']), async (req, res) => {
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

// ── SPA fallback — must be LAST ───────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path === '/login' || req.path === '/login.html') {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
    // Single interval: check new tickets every 30 min + overdue every run
    checkNewAndOverdue();
    setInterval(checkNewAndOverdue, 30 * 60 * 1000);
    // Telegram linking bot
    telegramLinkBot.setPool(pool);
    telegramLinkBot.startPolling(15000);
    console.log('✅ Telegram link bot started');
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const TG_TOKEN = process.env.TG_TOKEN;
const TG_OPS = process.env.TG_OPS_CHAT;    // Оперативная группа
const TG_MGT = process.env.TG_MGT_CHAT;    // Руководство
const ENTITY_TYPE_ID = 1058;
const CATEGORY_ID = 11;
const DASH_URL = process.env.DASH_URL || 'https://bitrix-service-dashboard-production.up.railway.app';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

function flattenInto(parts, obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') flattenInto(parts, item, `${key}[${i}]`);
        else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else if (typeof v === 'object') {
      flattenInto(parts, v, key);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
}

async function b24(method, params = {}) {
  const parts = [];
  flattenInto(parts, params, '');
  const url = `${BITRIX_WEBHOOK}${method}.json?${parts.join('&')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bitrix API error: ${res.status}`);
  return res.json();
}

async function tgSend(chatId, text, extra = {}) {
  if (!TG_TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra }),
    });
  } catch (e) { console.error('TG error:', e.message); }
}

async function tgBroadcast(text, extra = {}) {
  await Promise.all([
    tgSend(TG_OPS, text, extra),
    tgSend(TG_MGT, text, extra),
  ]);
}

// ── Config ────────────────────────────────────────────────────────────────────

const STAGES = {
  'DT1058_11:NEW':         { name: 'Необработанные',      color: '#22B9FF', order: 1, active: true },
  'DT1058_11:PREPARATION': { name: 'Досбор / Назначение', color: '#88B9FF', order: 2, active: true },
  'DT1058_11:CLIENT':      { name: 'Заявка в работе',     color: '#10e5fc', order: 3, active: true },
  'DT1058_11:1':           { name: 'Срочная в работе',    color: '#FF6B35', order: 4, active: true },
  'DT1058_11:2':           { name: 'Заявка на обучение',  color: '#9B59B6', order: 5, active: true },
  'DT1058_11:3':           { name: 'Заявка исполнена',    color: '#55D0E0', order: 6, active: true },
  'DT1058_11:4':           { name: 'Претензия',           color: '#FF5752', order: 7, active: true },
  'DT1058_11:SUCCESS':     { name: 'Заявка закрыта',      color: '#00C851', order: 8, active: false },
  'DT1058_11:FAIL':        { name: 'Заявка отменена',     color: '#ff4444', order: 9, active: false },
};

const COORDINATOR_STAGES = new Set(['DT1058_11:NEW', 'DT1058_11:PREPARATION']);
const COORDINATORS = new Set([26, 79]);

const USERS = {
  1:'Администратор',4:'Куаныш Есенов',7:'Мирас Актайлаков',8:'Рустам Абылкасимов',
  9:'Мурат Булегенов',10:'Асылбек Ожикен',11:'Гаухар Ахметжан',12:'Айжан Байжигитова',
  13:'Назерке Марат',14:'Канат Жунусов',15:'Семен Жаров',16:'Дамели Садырова',
  18:'Александр Якунин',19:'Ерлан Адильбеков',20:'Айнур Разакова',21:'Жадыра Сагитова',
  22:'Данияр Орахбаев',23:'Бахытгуль Даут',24:'Шокан Рымбек',25:'Рауан Жаксылык',
  26:'Азамат Аннабаев',27:'Маржан Доскенова',28:'Айнур Карпсеитова',29:'Борис Егоров',
  31:'Куаныш Нурмаганбетов',32:'Акерке Шотанова',33:'Аннель Лекер',34:'Гульнур Касымханова',
  36:'Аруна Болатова',37:'Акгулим Самиголлаева',38:'Талант Амангелді',39:'Мансұр Сейтжанұлы',
  40:'Каха Чоговадзе',41:'Наталья Зенченко',44:'Бақытжан Шаймұрат',45:'Азат Манат',
  46:'Жандос Кунаев',47:'Дмитрий Сорокин',48:'Дарын Негметжанов',50:'Нурбек Ибраемов',
  55:'Нурхат Оразгалиев',67:'Айнель Сеитова',68:'Игорь Бодров',71:'Азамат Алиев',
  73:'Ерасыл Махаш',76:'Аскат Көбей',77:'Адиль Тасмагамбетов',78:'Дмитрий Волков',
  79:'Арман Манасаев',85:'Максим Мазняк',86:'Аманжол Сыздыков',88:'Асем Жарылгап',
  90:'Ерқанат Сырғабек',
};

const SERVICE_TYPES = {
  '103':'Установка','104':'Техническое обслуживание','105':'Диагностика',
  '106':'Ремонт','108':'Обучение','109':'Обучение ТЦ','110':'Квалификация (IQ/OQ/PQ)',
  '111':'Подбор доп. оборудования','114':'Другое','402':'Подготовка документов',
  '619':'Заявка клиента',
};

const URGENCY_MAP = { '1809':'Срочная','1810':'Не срочная','1811':'Обучение ТЦ' };

// ── Enrich helper ─────────────────────────────────────────────────────────────

function enrichItem(t) {
  const uid = t.assignedById;
  const userName = USERS[uid] || `Пользователь ${uid}`;
  const isCoordUser = COORDINATORS.has(uid);
  const isCoordStage = COORDINATOR_STAGES.has(t.stageId);
  const coordName = isCoordUser ? userName : null;
  const engName = (!isCoordUser && !isCoordStage) ? userName : null;

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
    coordinator: coordName,
    engineer: engName,
    serviceTypes: svcIds.map(id => SERVICE_TYPES[id] || `Тип ${id}`),
    description: t.ufCrm8_1760688207256 || t.ufCrm8_1732855669306 || null,
    comment: t.ufCrm8_1732856926809 || null,
    movedTime: t.movedTime || null,
    daysOnStage: t.movedTime ? Math.floor((Date.now() - new Date(t.movedTime)) / 86400000) : null,
    bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/details/${t.id}/`,
  };
}

// ── GET /api/tickets ──────────────────────────────────────────────────────────

app.get('/api/tickets', async (req, res) => {
  try {
    const { stage, urgent, overdue, search, engineer, coordinator, serviceType, presetSvcTypes } = req.query;

    const filter = { categoryId: CATEGORY_ID };
    if (stage && stage !== 'all' && stage !== 'active') {
      filter.stageId = stage;
    } else if (!stage || stage === 'active') {
      filter.stageId = Object.entries(STAGES).filter(([,v]) => v.active).map(([k]) => k);
    }
    if (urgent && urgent !== 'all') filter['ufCrm8_1732856252874'] = urgent;
    if (overdue === 'yes') filter['ufCrm8_1732856215147'] = '1807';
    if (serviceType && serviceType !== 'all') filter['ufCrm8_1744300223'] = serviceType;

    let items = [], start = 0, total = Infinity;
    while (items.length < Math.min(total, 500)) {
      const data = await b24('crm.item.list', {
        entityTypeId: ENTITY_TYPE_ID, filter,
        select: ['id','title','stageId','createdTime','updatedTime','assignedById',
          'ufCrm8_1744300223','ufCrm8_1732856252874','ufCrm8_1732856215147',
          'ufCrm8_1760688207256','ufCrm8_1732855669306','ufCrm8_1732856926809','movedTime'],
        order: { createdTime: 'DESC' }, start,
      });
      if (!data.result?.items?.length) break;
      items = items.concat(data.result.items);
      total = data.total ?? data.result?.total ?? items.length;
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

    // Preset service type filter (client-side OR logic across multiple types)
    if (presetSvcTypes && presetSvcTypes !== '') {
      const allowedIds = new Set(presetSvcTypes.split(','));
      enriched = enriched.filter(t =>
        t.serviceTypeIds && t.serviceTypeIds.length > 0
          ? t.serviceTypeIds.some(id => allowedIds.has(String(id)))
          : false
      );
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

    const stats = { total: enriched.length, urgent: 0, overdue: 0, byStage: {} };
    for (const t of enriched) {
      if (t.urgency === 'Срочная') stats.urgent++;
      if (t.isOverdue) stats.overdue++;
    }
    for (const [sid, cfg] of Object.entries(STAGES)) {
      stats.byStage[sid] = { name: cfg.name, color: cfg.color, count: enriched.filter(t => t.stageId === sid).length };
    }

    res.json({ ok: true, items: enriched, stats, stages: STAGES,
      engineers: [...engineerSet].sort(), coordinators: [...coordSet].sort(), serviceTypes: SERVICE_TYPES });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/comment ─────────────────────────────────────────────────────────

app.post('/api/comment', async (req, res) => {
  try {
    const { ticketId, comment, stageId, engineerId, authorName, sendTg } = req.body;
    if (!ticketId) return res.status(400).json({ ok: false, error: 'ticketId required' });

    const fields = {};
    if (comment) fields['ufCrm8_1732856926809'] = comment;
    if (stageId) fields.stageId = stageId;
    if (engineerId) fields.assignedById = engineerId;

    if (Object.keys(fields).length > 0) {
      await b24('crm.item.update', { entityTypeId: ENTITY_TYPE_ID, id: ticketId, fields });
    }

    // Also add to timeline
    if (comment) {
      await b24('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: ticketId,
          ENTITY_TYPE: 'dynamic_1058',
          COMMENT: `💬 ${authorName || 'Координатор'}: ${comment}`,
        }
      }).catch(() => {});
    }

    // Fetch updated ticket for TG message
    const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId });
    const t = enrichItem(data.result?.item || { id: ticketId, stageId: '', title: '' });
    const cleanTitle = (t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim() || `Заявка #${ticketId}`;

    const stageChange = stageId ? `\n📌 Стадия → <b>${STAGES[stageId]?.name || stageId}</b>` : '';
    const engChange = engineerId ? `\n👤 Инженер → <b>${USERS[engineerId] || engineerId}</b>` : '';
    const commentLine = comment ? `\n💬 <b>${authorName || 'Координатор'}:</b> ${comment}` : '';

    const tgText = `✏️ <b>Обновление заявки #${ticketId}</b>\n` +
      `📋 ${cleanTitle}${stageChange}${engChange}${commentLine}\n` +
      `🔗 <a href="${t.bitrixUrl}">Открыть в Битрикс24</a>`;

    if (sendTg !== false) await tgBroadcast(tgText);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/remind ──────────────────────────────────────────────────────────

app.post('/api/remind', async (req, res) => {
  try {
    const { ticketId, message, delayMinutes, authorName, targetChat, sendTg } = req.body;
    if (!ticketId) return res.status(400).json({ ok: false, error: 'ticketId required' });

    const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId });
    const t = enrichItem(data.result?.item || { id: ticketId, stageId: '', title: '' });
    const cleanTitle = (t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim() || `Заявка #${ticketId}`;

    const sendReminder = async () => {
      const tgText = `🔔 <b>Напоминание по заявке #${ticketId}</b>\n` +
        `📋 ${cleanTitle}\n` +
        (message ? `📝 ${message}\n` : '') +
        `👤 От: ${authorName || 'Координатор'}\n` +
        `🔗 <a href="${t.bitrixUrl}">Открыть в Битрикс24</a>`;

      const chat = targetChat === 'mgt' ? TG_MGT : targetChat === 'both' ? null : TG_OPS;
      if (sendTg !== false) {
        if (chat === null) await tgBroadcast(tgText);
        else await tgSend(chat, tgText);
      }
    };

    const delay = Math.max(0, Math.min(parseInt(delayMinutes)||0, 1440)) * 60 * 1000;
    if (delay > 0) setTimeout(sendReminder, delay);
    else await sendReminder();

    res.json({ ok: true, scheduledIn: delay / 60000 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/task ────────────────────────────────────────────────────────────

app.post('/api/task', async (req, res) => {
  try {
    const { ticketId, taskTitle, taskDesc, responsibleId, deadline, authorName, sendTg } = req.body;
    if (!ticketId) return res.status(400).json({ ok: false, error: 'ticketId required' });

    const data = await b24('crm.item.get', { entityTypeId: ENTITY_TYPE_ID, id: ticketId });
    const t = enrichItem(data.result?.item || { id: ticketId, stageId: '', title: '' });
    const cleanTitle = (t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim() || `Заявка #${ticketId}`;

    // Create task in B24
    const taskData = await b24('tasks.task.add', {
      fields: {
        TITLE: taskTitle || `Заявка #${ticketId}: ${cleanTitle}`.slice(0, 100),
        DESCRIPTION: taskDesc || '',
        RESPONSIBLE_ID: responsibleId || 26,
        DEADLINE: deadline || '',
        UF_CRM_TASK: [`D_${ENTITY_TYPE_ID}_${ticketId}`],
      }
    });

    const taskId = taskData.result?.task?.id;

    // TG notification
    const tgText = `📋 <b>Создана задача в Битрикс24</b>\n` +
      `🎫 Заявка #${ticketId}: ${cleanTitle}\n` +
      `📝 ${taskTitle || 'Без названия'}\n` +
      (deadline ? `⏰ Дедлайн: ${new Date(deadline).toLocaleDateString('ru')}\n` : '') +
      `👤 Ответственный: ${USERS[responsibleId] || 'Не назначен'}\n` +
      `👤 Создал: ${authorName || 'Координатор'}\n` +
      `🔗 <a href="${t.bitrixUrl}">Открыть заявку в Б24</a>`;

    if (sendTg !== false) await tgBroadcast(tgText);

    res.json({ ok: true, taskId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/users ────────────────────────────────────────────────────────────

app.get('/api/users', (_, res) => {
  const engineers = Object.entries(USERS)
    .filter(([id]) => !COORDINATORS.has(Number(id)) && Number(id) > 10)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  res.json({ ok: true, users: engineers, coordinators: [...COORDINATORS].map(id => ({ id, name: USERS[id] })) });
});

app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Dashboard running on port ${PORT}`));

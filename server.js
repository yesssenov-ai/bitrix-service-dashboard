require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const cookieParser = require('cookie-parser');
const { initDB, requireAuth, auditLog, canEdit } = require('./auth');
const { tgMgt, tgOps, tgBoth, notifyNewTicket, notifyOverdueNew } = require('./notifications');

const app = express();
const PORT = process.env.PORT || 3000;
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
// TG handled via notifications.js
const ENTITY_TYPE_ID = 1058;
const CATEGORY_ID = 11;

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────────
app.use('/auth', require('./routes/auth-routes'));

// ── Admin routes (admin only) ─────────────────────────────────────────────────
app.use('/admin', require('./routes/admin-routes'));

// ── Login redirect ────────────────────────────────────────────────────────────
app.get('/login', (_, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin-panel', requireAuth(['admin']), (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

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

// tg functions from notifications module

// ── Config ────────────────────────────────────────────────────────────────────
const STAGES = {
  'DT1058_11:NEW':         { name:'Необработанные',      color:'#22B9FF', order:1, active:true },
  'DT1058_11:PREPARATION': { name:'Досбор / Назначение', color:'#88B9FF', order:2, active:true },
  'DT1058_11:CLIENT':      { name:'Заявка в работе',     color:'#10e5fc', order:3, active:true },
  'DT1058_11:1':           { name:'Срочная в работе',    color:'#FF6B35', order:4, active:true },
  'DT1058_11:2':           { name:'Заявка на обучение',  color:'#9B59B6', order:5, active:true },
  'DT1058_11:3':           { name:'Заявка исполнена',    color:'#55D0E0', order:6, active:true },
  'DT1058_11:4':           { name:'Претензия',           color:'#FF5752', order:7, active:true },
  'DT1058_11:SUCCESS':     { name:'Заявка закрыта',      color:'#00C851', order:8, active:false },
  'DT1058_11:FAIL':        { name:'Заявка отменена',     color:'#ff4444', order:9, active:false },
};

const COORDINATOR_STAGES = new Set(['DT1058_11:NEW','DT1058_11:PREPARATION']);
const COORDINATORS = new Set([26,79]);

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
  79:'Арман Манаспаев',85:'Максим Мазняк',86:'Аманжол Сыздыков',88:'Асем Жарылгап',90:'Ерқанат Сырғабек',
};

const SERVICE_TYPES = {
  '103':'Установка','104':'Техническое обслуживание','105':'Диагностика',
  '106':'Ремонт','108':'Обучение','109':'Обучение ТЦ','110':'Квалификация (IQ/OQ/PQ)',
  '111':'Подбор доп. оборудования','114':'Другое','402':'Подготовка документов','619':'Заявка клиента',
};

const URGENCY_MAP = {'1809':'Срочная','1810':'Не срочная','1811':'Обучение ТЦ'};

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
    title: t.title||'—',
    stageId: t.stageId,
    stageName: STAGES[t.stageId]?.name||t.stageId,
    stageColor: STAGES[t.stageId]?.color||'#ccc',
    isActive: STAGES[t.stageId]?.active??true,
    createdTime: t.createdTime,
    urgency: URGENCY_MAP[t.ufCrm8_1732856252874]||null,
    isOverdue: t.ufCrm8_1732856215147==='1807',
    coordinator: isCoordUser ? userName : null,
    engineer: (!isCoordUser&&!isCoordStage) ? userName : null,
    serviceTypes: svcIds.map(id=>SERVICE_TYPES[id]||`Тип ${id}`),
    serviceTypeIds: svcIds,
    description: t.ufCrm8_1760688207256||t.ufCrm8_1732855669306||null,
    comment: t.ufCrm8_1732856926809||null,
    movedTime: t.movedTime||null,
    daysOnStage: t.movedTime ? Math.floor((Date.now()-new Date(t.movedTime))/86400000) : null,
    bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/details/${t.id}/`,
  };
}

// ── GET /api/tickets — requires auth ─────────────────────────────────────────
app.get('/api/tickets', requireAuth(), async (req, res) => {
  try {
    const { urgent, overdue, search, engineer, coordinator, serviceType, presetSvcTypes } = req.query;
    const filter = { categoryId: CATEGORY_ID };
    filter.stageId = Object.entries(STAGES).filter(([,v])=>v.active).map(([k])=>k);
    if (urgent && urgent!=='all') filter['ufCrm8_1732856252874']=urgent;
    if (overdue==='yes') filter['ufCrm8_1732856215147']='1807';
    if (serviceType && serviceType!=='all') filter['ufCrm8_1744300223']=serviceType;

    let items=[],start=0,total=Infinity;
    while(items.length<Math.min(total,500)){
      const data=await b24('crm.item.list',{
        entityTypeId:ENTITY_TYPE_ID,filter,
        select:['id','title','stageId','createdTime','updatedTime','assignedById',
          'ufCrm8_1744300223','ufCrm8_1732856252874','ufCrm8_1732856215147',
          'ufCrm8_1760688207256','ufCrm8_1732855669306','ufCrm8_1732856926809','movedTime'],
        order:{createdTime:'DESC'},start,
      });
      if(!data.result?.items?.length) break;
      items=items.concat(data.result.items);
      total=data.total??data.result?.total??items.length;
      start=items.length;
      if(!data.next||items.length>=total) break;
    }

    const engineerSet=new Set(),coordSet=new Set();
    let enriched=items.map(t=>{
      const e=enrichItem(t);
      if(e.engineer) engineerSet.add(e.engineer);
      if(e.coordinator) coordSet.add(e.coordinator);
      return e;
    });

    if(engineer&&engineer!=='all') enriched=enriched.filter(t=>t.engineer===engineer);
    if(coordinator&&coordinator!=='all') enriched=enriched.filter(t=>t.coordinator===coordinator);
    if(presetSvcTypes&&presetSvcTypes!==''){
      const allowed=new Set(presetSvcTypes.split(','));
      enriched=enriched.filter(t=>Array.isArray(t.serviceTypeIds)&&t.serviceTypeIds.length>0&&t.serviceTypeIds.some(id=>allowed.has(String(id))));
    }
    if(search?.trim()){
      const q=search.toLowerCase();
      enriched=enriched.filter(t=>(t.title||'').toLowerCase().includes(q)||(t.description||'').toLowerCase().includes(q)||(t.engineer||'').toLowerCase().includes(q)||(t.coordinator||'').toLowerCase().includes(q));
    }

    // Preset counts
    const allEnriched=items.map(t=>enrichItem(t));
    const PRESET_SVC={
      tickets:new Set(['619','114','4']),
      docs:new Set(['402','111']),
      obligations:new Set(['103','104','105','106','108','109','110']),
    };
    const presetCounts={all:allEnriched.length};
    for(const[key,svcSet] of Object.entries(PRESET_SVC)){
      presetCounts[key]=allEnriched.filter(t=>Array.isArray(t.serviceTypeIds)&&t.serviceTypeIds.length>0&&t.serviceTypeIds.some(id=>svcSet.has(String(id)))).length;
    }
    presetCounts.overdue=allEnriched.filter(t=>t.isOverdue).length;

    const stats={total:enriched.length,urgent:enriched.filter(t=>t.urgency==='Срочная').length,overdue:enriched.filter(t=>t.isOverdue).length,byStage:{}};
    for(const[sid,cfg] of Object.entries(STAGES)){
      stats.byStage[sid]={name:cfg.name,color:cfg.color,count:enriched.filter(t=>t.stageId===sid).length};
    }

    res.json({ok:true,items:enriched,stats,stages:STAGES,engineers:[...engineerSet].sort(),coordinators:[...coordSet].sort(),serviceTypes:SERVICE_TYPES,presetCounts,
      currentUser:{role:req.user.role,engineerName:req.user.engineer_name,displayName:req.user.display_name}});
  } catch(err){ console.error(err); res.status(500).json({ok:false,error:err.message}); }
});

// ── POST /api/comment ─────────────────────────────────────────────────────────
app.post('/api/comment', requireAuth(['admin','coordinator','engineer']), async (req, res) => {
  try {
    const { ticketId, comment, stageId, engineerId, sendTg } = req.body;
    const authorName = req.user.display_name;
    const ip = req.headers['x-forwarded-for']||req.ip;

    // Engineer can only edit own tickets
    if(req.user.role==='engineer') {
      const data=await b24('crm.item.get',{entityTypeId:ENTITY_TYPE_ID,id:ticketId});
      const t=enrichItem(data.result?.item||{});
      if(!canEdit(req.user,t)) return res.status(403).json({ok:false,error:'Нет прав на редактирование этой заявки'});
    }

    const fields={};
    if(comment) fields['ufCrm8_1732856926809']=comment;
    if(stageId) fields.stageId=stageId;
    if(engineerId) fields.assignedById=engineerId;
    if(Object.keys(fields).length>0) await b24('crm.item.update',{entityTypeId:ENTITY_TYPE_ID,id:ticketId,fields});

    if(comment) {
      await b24('crm.timeline.comment.add',{fields:{ENTITY_ID:ticketId,ENTITY_TYPE:'dynamic_1058',COMMENT:`💬 ${authorName}: ${comment}`}}).catch(()=>{});
    }

    // Audit log
    const details={};
    if(comment) details.comment=comment.slice(0,100);
    if(stageId) details.stage=STAGES[stageId]?.name||stageId;
    if(engineerId) details.engineer=USERS[engineerId]||engineerId;
    if(comment) await auditLog(req.user.id,req.user.username,'COMMENT_ADDED',ticketId,details,ip,req.headers['user-agent']);
    if(stageId) await auditLog(req.user.id,req.user.username,'STAGE_CHANGED',ticketId,{from:'?',to:STAGES[stageId]?.name||stageId},ip,req.headers['user-agent']);
    if(engineerId) await auditLog(req.user.id,req.user.username,'ENGINEER_ASSIGNED',ticketId,{engineer:USERS[engineerId]||engineerId},ip,req.headers['user-agent']);

    if(sendTg!==false) {
      const data=await b24('crm.item.get',{entityTypeId:ENTITY_TYPE_ID,id:ticketId}).catch(()=>({result:{item:{id:ticketId,title:'',stageId:''}}}));
      const t=enrichItem(data.result?.item||{id:ticketId,title:'',stageId:''});
      const cleanTitle=(t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim()||`Заявка #${ticketId}`;
      const sc=stageId?`\n📌 Стадия → <b>${STAGES[stageId]?.name||stageId}</b>`:'';
      const ec=engineerId?`\n👤 Инженер → <b>${USERS[engineerId]||engineerId}</b>`:'';
      const cc=comment?`\n💬 <b>${authorName}:</b> ${comment}`:'';
      await tgBoth(`✏️ <b>Обновление заявки #${ticketId}</b>\n📋 ${cleanTitle}${sc}${ec}${cc}\n🔗 <a href="${t.bitrixUrl}">Открыть в Битрикс24</a>`);
    }

    res.json({ok:true});
  } catch(err){ console.error(err); res.status(500).json({ok:false,error:err.message}); }
});

// ── POST /api/remind ──────────────────────────────────────────────────────────
app.post('/api/remind', requireAuth(['admin','coordinator']), async (req, res) => {
  try {
    const {ticketId,message,delayMinutes,targetChat,sendTg}=req.body;
    const authorName=req.user.display_name;
    const ip=req.headers['x-forwarded-for']||req.ip;
    const data=await b24('crm.item.get',{entityTypeId:ENTITY_TYPE_ID,id:ticketId}).catch(()=>({result:{item:{id:ticketId,title:'',stageId:''}}}));
    const t=enrichItem(data.result?.item||{id:ticketId,title:'',stageId:''});
    const cleanTitle=(t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim()||`Заявка #${ticketId}`;

    const sendReminder=async()=>{
      const tgText=`🔔 <b>Напоминание по заявке #${ticketId}</b>\n📋 ${cleanTitle}\n${message?`📝 ${message}\n`:''}👤 От: ${authorName}\n🔗 <a href="${t.bitrixUrl}">Открыть в Битрикс24</a>`;
      const chat=targetChat==='mgt'?TG_MGT:targetChat==='both'?null:TG_OPS;
      if(chat===null) await tgBoth(tgText); else await tgSend(chat,tgText);
    };

    const delay=Math.max(0,Math.min(parseInt(delayMinutes)||0,1440))*60*1000;
    if(delay>0) setTimeout(sendReminder,delay); else if(sendTg!==false) await sendReminder();
    await auditLog(req.user.id,req.user.username,'REMIND_SENT',ticketId,{message:message?.slice(0,100),delay:delayMinutes,chat:targetChat},ip,req.headers['user-agent']);
    res.json({ok:true,scheduledIn:delay/60000});
  } catch(err){ console.error(err); res.status(500).json({ok:false,error:err.message}); }
});

// ── POST /api/task ────────────────────────────────────────────────────────────
app.post('/api/task', requireAuth(['admin','coordinator']), async (req, res) => {
  try {
    const {ticketId,taskTitle,taskDesc,responsibleId,deadline,sendTg}=req.body;
    const authorName=req.user.display_name;
    const ip=req.headers['x-forwarded-for']||req.ip;
    const data=await b24('crm.item.get',{entityTypeId:ENTITY_TYPE_ID,id:ticketId}).catch(()=>({result:{item:{id:ticketId,title:'',stageId:''}}}));
    const t=enrichItem(data.result?.item||{id:ticketId,title:'',stageId:''});
    const cleanTitle=(t.title||'').replace(/^[-\s–—]+/,'').replace(/[-\s–—]+$/,'').trim()||`Заявка #${ticketId}`;

    const taskData=await b24('tasks.task.add',{fields:{
      TITLE:taskTitle||(cleanTitle.slice(0,100)),
      DESCRIPTION:taskDesc||'',
      RESPONSIBLE_ID:responsibleId||26,
      DEADLINE:deadline||'',
      UF_CRM_TASK:[`D_${ENTITY_TYPE_ID}_${ticketId}`],
    }});

    const taskId=taskData.result?.task?.id;
    await auditLog(req.user.id,req.user.username,'TASK_CREATED',ticketId,{taskId,taskTitle,responsibleId:USERS[responsibleId]||responsibleId},ip,req.headers['user-agent']);

    if(sendTg!==false){
      const tgText=`📋 <b>Создана задача в Битрикс24</b>\n🎫 Заявка #${ticketId}: ${cleanTitle}\n📝 ${taskTitle||'Без названия'}\n${deadline?`⏰ Дедлайн: ${new Date(deadline).toLocaleDateString('ru')}\n`:''}👤 Ответственный: ${USERS[responsibleId]||'—'}\n👤 Создал: ${authorName}\n🔗 <a href="${t.bitrixUrl}">Открыть заявку</a>`;
      await tgBoth(tgText);
    }
    res.json({ok:true,taskId});
  } catch(err){ console.error(err); res.status(500).json({ok:false,error:err.message}); }
});

// ── GET /api/users ────────────────────────────────────────────────────────────
app.get('/api/users', requireAuth(), (_, res) => {
  const engineers=Object.entries(USERS).filter(([id])=>!COORDINATORS.has(Number(id))&&Number(id)>10).map(([id,name])=>({id:Number(id),name})).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  res.json({ok:true,users:engineers,coordinators:[...COORDINATORS].map(id=>({id,name:USERS[id]}))});
});

app.get('/api/health', (_, res) => res.json({ok:true,ts:new Date().toISOString()}));

// ── SPA fallback — protect index ──────────────────────────────────────────────
app.get('/', requireAuth(), (_, res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('*', (req, res) => {
  // Public routes
  if(req.path==='/login'||req.path==='/login.html') return res.sendFile(path.join(__dirname,'public','login.html'));
  res.sendFile(path.join(__dirname,'public','index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
// Track already notified new tickets
const notifiedNewTickets = new Set();
let lastKnownTicketIds = new Set();
let isFirstLoad = true;

async function checkNewAndOverdue() {
  try {
    // Fetch all NEW stage tickets
    const parts = [];
    flattenInto(parts, {
      entityTypeId: ENTITY_TYPE_ID,
      filter: { categoryId: CATEGORY_ID, stageId: 'DT1058_11:NEW' },
      select: ['id','title','stageId','createdTime','movedTime','assignedById',
        'ufCrm8_1744300223','ufCrm8_1732856252874','ufCrm8_1732856215147',
        'ufCrm8_1760688207256'],
      order: { createdTime: 'DESC' },
      start: 0,
    }, '');
    const url = `${BITRIX_WEBHOOK}crm.item.list.json?${parts.join('&')}`;
    const res = await fetch(url);
    const data = await res.json();
    const items = data.result?.items || [];
    const enriched = items.map(t => enrichItem(t));

    const currentIds = new Set(enriched.map(t => t.id));

    // New tickets (appeared since last check)
    if (!isFirstLoad) {
      for (const t of enriched) {
        if (!lastKnownTicketIds.has(t.id) && !notifiedNewTickets.has(t.id)) {
          notifiedNewTickets.add(t.id);
          await notifyNewTicket(t);
        }
      }
    } else {
      // On first load just record existing IDs
      enriched.forEach(t => notifiedNewTickets.add(t.id));
      isFirstLoad = false;
    }
    lastKnownTicketIds = currentIds;

    // Overdue NEW: movedTime > 8 hours ago
    const EIGHT_HOURS = 8 * 60 * 60 * 1000;
    const overdueNew = enriched.filter(t => {
      if (!t.movedTime) return false;
      return (Date.now() - new Date(t.movedTime)) > EIGHT_HOURS;
    });
    if (overdueNew.length > 0) {
      await notifyOverdueNew(overdueNew);
    }
  } catch(e) {
    console.error('checkNewAndOverdue error:', e.message);
  }
}

initDB().then(()=>{
  app.listen(PORT, ()=>{
    console.log(`✅ Dashboard running on port ${PORT}`);
    // Check immediately then every hour
    checkNewAndOverdue();
    setInterval(checkNewAndOverdue, 60 * 60 * 1000);
    // Also check for new tickets every 2 minutes
    setInterval(async () => {
      try {
        const parts = [];
        flattenInto(parts, {
          entityTypeId: ENTITY_TYPE_ID,
          filter: { categoryId: CATEGORY_ID, stageId: 'DT1058_11:NEW' },
          select: ['id','title','stageId','createdTime','movedTime','assignedById',
            'ufCrm8_1744300223','ufCrm8_1732856252874','ufCrm8_1732856215147',
            'ufCrm8_1760688207256'],
          order: { createdTime: 'DESC' },
          start: 0,
        }, '');
        const url = `${BITRIX_WEBHOOK}crm.item.list.json?${parts.join('&')}`;
        const res = await fetch(url);
        const data = await res.json();
        const items = (data.result?.items || []).map(t => enrichItem(t));
        const currentIds = new Set(items.map(t => t.id));
        if (!isFirstLoad) {
          for (const t of items) {
            if (!lastKnownTicketIds.has(t.id) && !notifiedNewTickets.has(t.id)) {
              notifiedNewTickets.add(t.id);
              await notifyNewTicket(t);
            }
          }
        }
        lastKnownTicketIds = currentIds;
      } catch(e) { console.error('New ticket check error:', e.message); }
    }, 30 * 60 * 1000);
  });
}).catch(err=>{
  console.error('DB init failed:', err);
  process.exit(1);
});

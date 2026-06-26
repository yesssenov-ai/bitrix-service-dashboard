require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const ENTITY_TYPE_ID = 1058;
const CATEGORY_ID = 11;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function b24(method, params = {}) {
  const url = `${BITRIX_WEBHOOK}${method}.json`;
  const qs = new URLSearchParams(flattenParams(params)).toString();
  const res = await fetch(`${url}?${qs}`);
  if (!res.ok) throw new Error(`Bitrix API error: ${res.status}`);
  return res.json();
}

function flattenParams(obj, prefix = '') {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(result, flattenParams(v, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') Object.assign(result, flattenParams(item, `${key}[${i}]`));
        else result[`${key}[${i}]`] = item;
      });
    } else {
      result[key] = v;
    }
  }
  return result;
}

// ── Config ────────────────────────────────────────────────────────────────────

const STAGES = {
  'DT1058_11:NEW':         { name: 'Необработанные', color: '#22B9FF', order: 1, active: true },
  'DT1058_11:PREPARATION': { name: 'Досбор / Назначение', color: '#88B9FF', order: 2, active: true },
  'DT1058_11:CLIENT':      { name: 'Заявка в работе', color: '#10e5fc', order: 3, active: true },
  'DT1058_11:1':           { name: 'Срочная в работе', color: '#FF6B35', order: 4, active: true },
  'DT1058_11:2':           { name: 'Заявка на обучение', color: '#9B59B6', order: 5, active: true },
  'DT1058_11:3':           { name: 'Заявка исполнена', color: '#55D0E0', order: 6, active: true },
  'DT1058_11:4':           { name: 'Претензия', color: '#FF5752', order: 7, active: true },
  'DT1058_11:SUCCESS':     { name: 'Заявка закрыта', color: '#00C851', order: 8, active: false },
  'DT1058_11:FAIL':        { name: 'Заявка отменена', color: '#ff4444', order: 9, active: false },
};

// Тип оказываемых услуг (iblock ID 25)
const SERVICE_TYPES = {
  '103': 'Установка',
  '104': 'Техническое обслуживание',
  '105': 'Диагностика',
  '106': 'Ремонт',
  '107': 'Обучение сервисного отдела',
  '108': 'Обучение ТЦ',
  '109': 'Квалификация (IQ/OQ/PQ)',
  '110': 'Квалификация (IQ/OQ/PQ)',
  '111': 'Подбор оборудования',
  '112': 'Подбор расходников',
  '113': 'Другое',
  '114': 'Методическое сопровождение',
  '619': 'Подбор доп. оборудования',
};

const URGENCY_MAP = { '1809': 'Срочная', '1810': 'Не срочная', '1811': 'Обучение ТЦ' };

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/tickets', async (req, res) => {
  try {
    const { stage, urgent, overdue, search, engineer, serviceType } = req.query;

    const filter = { categoryId: CATEGORY_ID };

    // Stage filter
    if (stage && stage !== 'all' && stage !== 'active') {
      filter.stageId = stage;
    } else if (!stage || stage === 'active') {
      const activeStages = Object.entries(STAGES).filter(([,v]) => v.active).map(([k]) => k);
      activeStages.forEach((s, i) => { filter[`stageId[${i}]`] = s; });
    }

    if (urgent && urgent !== 'all') filter['ufCrm8_1732856252874'] = urgent;
    if (overdue === 'yes') filter['ufCrm8_1732856215147'] = '1807';
    if (serviceType && serviceType !== 'all') filter['ufCrm8_1744300223'] = serviceType;

    // Paginate
    let items = [];
    let start = 0;
    let total = Infinity;

    while (items.length < Math.min(total, 500)) {
      const data = await b24('crm.item.list', {
        entityTypeId: ENTITY_TYPE_ID,
        filter,
        select: [
          'id', 'title', 'stageId', 'createdTime', 'updatedTime',
          'assignedById', 'companyId',
          'ufCrm8_1744300223',     // Тип услуг (iblock)
          'ufCrm8_1732856252874',  // Срочность
          'ufCrm8_1732856215147',  // Просрочена
          'ufCrm8_1757924163789',  // Ответств.инженер (текст)
          'ufCrm8_1760688207256',  // Краткое описание
          'ufCrm8_1732855669306',  // Текст запроса
          'ufCrmPribor',           // Название прибора
        ],
        order: { createdTime: 'DESC' },
        start,
      });

      if (!data.result?.items?.length) break;
      items = items.concat(data.result.items);
      total = data.total ?? data.result?.total ?? items.length;
      start = items.length;
      if (!data.next || items.length >= total) break;
    }

    // Client-side filters
    if (engineer && engineer !== 'all') {
      items = items.filter(t => (t.ufCrm8_1757924163789 || '') === engineer);
    }
    if (search?.trim()) {
      const q = search.toLowerCase();
      items = items.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.ufCrm8_1760688207256 || '').toLowerCase().includes(q) ||
        (t.ufCrm8_1757924163789 || '').toLowerCase().includes(q)
      );
    }

    // Collect unique engineers from results (for filter dropdown)
    const engineerSet = new Set();

    const enriched = items.map(t => {
      const eng = t.ufCrm8_1757924163789 || null;
      if (eng) engineerSet.add(eng);

      // Resolve service type names
      const svcIds = Array.isArray(t.ufCrm8_1744300223)
        ? t.ufCrm8_1744300223.map(String)
        : t.ufCrm8_1744300223 ? [String(t.ufCrm8_1744300223)] : [];
      const svcNames = svcIds.map(id => SERVICE_TYPES[id] || `ID:${id}`);

      return {
        id: t.id,
        title: t.title || '—',
        stageId: t.stageId,
        stageName: STAGES[t.stageId]?.name || t.stageId,
        stageColor: STAGES[t.stageId]?.color || '#ccc',
        isActive: STAGES[t.stageId]?.active ?? true,
        createdTime: t.createdTime,
        updatedTime: t.updatedTime,
        urgency: URGENCY_MAP[t.ufCrm8_1732856252874] || null,
        isOverdue: t.ufCrm8_1732856215147 === '1807',
        engineer: eng,
        serviceTypes: svcNames,
        serviceTypeIds: svcIds,
        description: t.ufCrm8_1760688207256 || t.ufCrm8_1732855669306 || null,
        bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/item/${t.id}/`,
      };
    });

    const stats = {
      total: enriched.length,
      urgent: enriched.filter(t => t.urgency === 'Срочная').length,
      overdue: enriched.filter(t => t.isOverdue).length,
      byStage: {},
    };
    for (const [sid, cfg] of Object.entries(STAGES)) {
      stats.byStage[sid] = {
        name: cfg.name, color: cfg.color,
        count: enriched.filter(t => t.stageId === sid).length,
      };
    }

    res.json({
      ok: true,
      items: enriched,
      stats,
      stages: STAGES,
      engineers: [...engineerSet].sort(),
      serviceTypes: SERVICE_TYPES,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Dashboard running on port ${PORT}`));

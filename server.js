require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK; // https://crm.prolabsupport.kz/rest/4/xxxxx/
const ENTITY_TYPE_ID = 1058;
const CATEGORY_ID = 11;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// Stage config
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

const URGENCY_MAP = { '1809': 'Срочная', '1810': 'Не срочная', '1811': 'Обучение ТЦ' };
const OVERDUE_MAP = { '1807': 'Да', '1808': 'Нет' };

// ── API Routes ────────────────────────────────────────────────────────────────

// GET /api/tickets - fetch all active tickets with pagination
app.get('/api/tickets', async (req, res) => {
  try {
    const { stage, engineer, urgent, overdue, search } = req.query;

    // Build filter
    const filter = { categoryId: CATEGORY_ID };

    // If no stage filter, show only active (non-terminal) stages
    if (stage && stage !== 'all') {
      filter.stageId = stage;
    } else if (!stage || stage === 'active') {
      // Active stages only
      const activeStages = Object.entries(STAGES)
        .filter(([, v]) => v.active)
        .map(([k]) => k);
      // Bitrix filter OR for stageId
      activeStages.forEach((s, i) => { filter[`stageId[${i}]`] = s; });
      delete filter.stageId;
    }
    // stage === 'all' → no stageId filter → all tickets

    if (urgent && urgent !== 'all') filter['ufCrm8_1732856252874'] = urgent;
    if (overdue === 'yes') filter['ufCrm8_1732856215147'] = '1807';

    // Fetch with pagination (max 50 per request, up to 500 total)
    let items = [];
    let start = 0;
    let total = Infinity;

    while (items.length < total) {
      const data = await b24('crm.item.list', {
        entityTypeId: ENTITY_TYPE_ID,
        filter,
        select: [
          'id', 'title', 'stageId', 'createdTime', 'updatedTime', 'closedate',
          'assignedById', 'companyId',
          'ufCrm8_1732856252874',  // Срочность
          'ufCrm8_1732856215147',  // Просрочена
          'ufCrm8_1732856309',     // Ответственный инженер/менеджер
          'ufCrm8_1732856367',     // Ответственный инженер
          'ufCrm8_1757924163789',  // Ответств.инженер (текст)
          'ufCrm8_1760688207256',  // Краткое описание проблемы
          'ufCrm8_1732855669306',  // Текст запроса
          'ufCrm8_1732856462984',  // Срок для предоставления ответа
          'ufCrmPribor',           // Название прибора
          'ufCrm8_1732855747',     // Производитель
        ],
        order: { createdTime: 'DESC' },
        start,
      });

      if (!data.result || !data.result.items) break;
      items = items.concat(data.result.items);
      total = data.total ?? data.result.total ?? items.length;
      start = items.length;
      if (!data.next || items.length >= total) break;
    }

    // Apply search filter client-side
    if (search && search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.ufCrm8_1760688207256 || '').toLowerCase().includes(q) ||
        (t.ufCrm8_1757924163789 || '').toLowerCase().includes(q)
      );
    }

    // Enrich items
    const enriched = items.map(t => ({
      id: t.id,
      title: t.title || '—',
      stageId: t.stageId,
      stageName: STAGES[t.stageId]?.name || t.stageId,
      stageColor: STAGES[t.stageId]?.color || '#ccc',
      isActive: STAGES[t.stageId]?.active ?? true,
      createdTime: t.createdTime,
      updatedTime: t.updatedTime,
      closedate: t.closedate,
      deadlineDate: t.ufCrm8_1732856462984,
      urgency: URGENCY_MAP[t.ufCrm8_1732856252874] || null,
      isOverdue: t.ufCrm8_1732856215147 === '1807',
      engineer: t.ufCrm8_1757924163789 || null,
      description: t.ufCrm8_1760688207256 || t.ufCrm8_1732855669306 || null,
      bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/item/${t.id}/`,
    }));

    // Stats
    const stats = {
      total: enriched.length,
      byStage: {},
      urgent: enriched.filter(t => t.urgency === 'Срочная').length,
      overdue: enriched.filter(t => t.isOverdue).length,
    };
    for (const [sid, cfg] of Object.entries(STAGES)) {
      stats.byStage[sid] = {
        name: cfg.name,
        color: cfg.color,
        count: enriched.filter(t => t.stageId === sid).length,
      };
    }

    res.json({ ok: true, items: enriched, stats, stages: STAGES });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/stats - summary stats for KPI cards
app.get('/api/stats', async (req, res) => {
  try {
    // Count per stage using separate calls
    const stageCounts = {};
    await Promise.all(
      Object.keys(STAGES).map(async (sid) => {
        const data = await b24('crm.item.list', {
          entityTypeId: ENTITY_TYPE_ID,
          filter: { categoryId: CATEGORY_ID, stageId: sid },
          select: ['id'],
          start: 0,
        });
        stageCounts[sid] = data.total ?? data.result?.total ?? 0;
      })
    );

    const activeCount = Object.entries(stageCounts)
      .filter(([sid]) => STAGES[sid]?.active)
      .reduce((s, [, c]) => s + c, 0);

    res.json({ ok: true, stageCounts, activeCount, stages: STAGES });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// SPA fallback
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`✅ Dashboard running on port ${PORT}`));

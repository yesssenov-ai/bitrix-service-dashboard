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

// ── Config ────────────────────────────────────────────────────────────────────

const STAGES = {
  'DT1058_11:NEW':         { name: 'Необработанные',        color: '#22B9FF', order: 1, active: true },
  'DT1058_11:PREPARATION': { name: 'Досбор / Назначение',   color: '#88B9FF', order: 2, active: true },
  'DT1058_11:CLIENT':      { name: 'Заявка в работе',       color: '#10e5fc', order: 3, active: true },
  'DT1058_11:1':           { name: 'Срочная в работе',      color: '#FF6B35', order: 4, active: true },
  'DT1058_11:2':           { name: 'Заявка на обучение',    color: '#9B59B6', order: 5, active: true },
  'DT1058_11:3':           { name: 'Заявка исполнена',      color: '#55D0E0', order: 6, active: true },
  'DT1058_11:4':           { name: 'Претензия',             color: '#FF5752', order: 7, active: true },
  'DT1058_11:SUCCESS':     { name: 'Заявка закрыта',        color: '#00C851', order: 8, active: false },
  'DT1058_11:FAIL':        { name: 'Заявка отменена',       color: '#ff4444', order: 9, active: false },
};

// Стадии где assignedById = координатор
const COORDINATOR_STAGES = new Set(['DT1058_11:NEW', 'DT1058_11:PREPARATION']);

// Все пользователи системы
const USERS = {
  1:  'Администратор',
  4:  'Куаныш Есенов',
  7:  'Мирас Актайлаков',
  8:  'Рустам Абылкасимов',
  9:  'Мурат Булегенов',
  10: 'Асылбек Ожикен',
  11: 'Гаухар Ахметжан',
  12: 'Айжан Байжигитова',
  13: 'Назерке Марат',
  14: 'Канат Жунусов',
  15: 'Семен Жаров',
  16: 'Дамели Садырова',
  18: 'Александр Якунин',
  19: 'Ерлан Адильбеков',
  20: 'Айнур Разакова',
  21: 'Жадыра Сагитова',
  22: 'Данияр Орахбаев',
  23: 'Бахытгуль Даут',
  24: 'Шокан Рымбек',
  25: 'Рауан Жаксылык',
  26: 'Азамат Аннабаев',
  27: 'Маржан Доскенова',
  28: 'Айнур Карпсеитова',
  29: 'Борис Егоров',
  31: 'Куаныш Нурмаганбетов',
  32: 'Акерке Шотанова',
  33: 'Аннель Лекер',
  34: 'Гульнур Касымханова',
  36: 'Аруна Болатова',
  37: 'Акгулим Самиголлаева',
  38: 'Талант Амангелді',
  39: 'Мансұр Сейтжанұлы',
  40: 'Каха Чоговадзе',
  41: 'Наталья Зенченко',
  44: 'Бақытжан Шаймұрат',
  45: 'Азат Манат',
  46: 'Жандос Кунаев',
  47: 'Дмитрий Сорокин',
  48: 'Дарын Негметжанов',
  50: 'Нурбек Ибраемов',
  55: 'Нурхат Оразгалиев',
  67: 'Айнель Сеитова',
  68: 'Игорь Бодров',
  71: 'Азамат Алиев',
  73: 'Ерасыл Махаш',
  76: 'Аскат Көбей',
  77: 'Адиль Тасмагамбетов',
  78: 'Дмитрий Волков',
  79: 'Арман Манасаев',
  85: 'Максим Мазняк',
  86: 'Аманжол Сыздыков',
  88: 'Асем Жарылгап',
  90: 'Ерқанат Сырғабек',
};

const COORDINATORS = new Set([26, 79]); // Азамат, Арман

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
    const { stage, urgent, overdue, search, engineer, coordinator, serviceType } = req.query;

    const filter = { categoryId: CATEGORY_ID };

    if (stage && stage !== 'all' && stage !== 'active') {
      filter.stageId = stage;
    } else if (!stage || stage === 'active') {
      filter.stageId = Object.entries(STAGES).filter(([,v]) => v.active).map(([k]) => k);
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
          'assignedById',
          'ufCrm8_1744300223',    // Тип услуг
          'ufCrm8_1732856252874', // Срочность
          'ufCrm8_1732856215147', // Просрочена
          'ufCrm8_1760688207256', // Краткое описание
          'ufCrm8_1732855669306', // Текст запроса
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

    // Enrich
    const engineerSet = new Set();
    const coordSet = new Set();

    const enriched = items.map(t => {
      const uid = t.assignedById;
      const userName = USERS[uid] || `Пользователь ${uid}`;
      const isCoordStage = COORDINATOR_STAGES.has(t.stageId);
      const isCoordUser = COORDINATORS.has(uid);

      // Координатор: всегда показываем если это Азамат или Арман
      const coordName = isCoordUser ? userName : null;
      // Инженер: assignedById когда НЕ координаторская стадия И НЕ координатор
      const engName = (!isCoordUser && !isCoordStage) ? userName : null;

      if (coordName) coordSet.add(coordName);
      if (engName) engineerSet.add(engName);

      const svcIds = Array.isArray(t.ufCrm8_1744300223)
        ? t.ufCrm8_1744300223.map(String)
        : t.ufCrm8_1744300223 ? [String(t.ufCrm8_1744300223)] : [];
      const svcNames = svcIds.map(id => SERVICE_TYPES[id] || `Тип ${id}`);

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
        serviceTypes: svcNames,
        description: t.ufCrm8_1760688207256 || t.ufCrm8_1732855669306 || null,
        bitrixUrl: `https://crm.prolabsupport.kz/crm/type/${ENTITY_TYPE_ID}/details/${t.id}/`,
      };
    });

    // Client-side filters
    let filtered = enriched;
    if (engineer && engineer !== 'all') {
      filtered = filtered.filter(t => t.engineer === engineer);
    }
    if (coordinator && coordinator !== 'all') {
      filtered = filtered.filter(t => t.coordinator === coordinator);
    }
    if (search?.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q) ||
        (t.engineer || '').toLowerCase().includes(q) ||
        (t.coordinator || '').toLowerCase().includes(q)
      );
    }

    const stats = {
      total: filtered.length,
      urgent: filtered.filter(t => t.urgency === 'Срочная').length,
      overdue: filtered.filter(t => t.isOverdue).length,
      byStage: {},
    };
    for (const [sid, cfg] of Object.entries(STAGES)) {
      stats.byStage[sid] = {
        name: cfg.name, color: cfg.color,
        count: filtered.filter(t => t.stageId === sid).length,
      };
    }

    res.json({
      ok: true,
      items: filtered,
      stats,
      stages: STAGES,
      engineers: [...engineerSet].sort(),
      coordinators: [...coordSet].sort(),
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

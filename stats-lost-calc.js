// «Проигранные сделки за N дней + причины» для Статистики.
// «Проигранные» = Заморожена + Провалена (обе — стадии с семантикой проигрыша 'F'
// во всех воронках: LOSE/APOLOGY и их C1:/C2:/C3: варианты). Разделяем по типу
// стадии и показываем её название.
//
// Источник — живой запрос в Битрикс (окно короткое, сделок мало): не меняем схему
// зеркала и всегда видим свежие проигрыши. Дата проигрыша — по DATE_MODIFY (момент
// перевода в стадию проигрыша; тем же полем пользуется инкрементальная синхронизация).
// Причина — поле-справочник UF_CRM_1744288907 (инфоблок 22), подтверждено
// find-lost-reason-field.js: 87 Не прошли по бюджету · 88 Дороже конкурентов ·
// 89 Отмена по инициативе заказчика · 90 Несоответствие техническим требованиям ·
// 91 Другое (с подробным описанием).
const { b24 } = require('./bitrix');
const { USERS } = require('./constants');
const { getTodayRate } = require('./nbrk-exchange-rate');

const REASON_FIELD = 'UF_CRM_1744288907';
const REASON_MAP = {
  '87': 'Не прошли по бюджету заказчика',
  '88': 'Дороже конкурентов',
  '89': 'Отмена по инициативе заказчика',
  '90': 'Несоответствие техническим требованиям',
  '91': 'Другое (с подробным описанием)',
};
// Свободный комментарий (заполняют непоследовательно, но иногда там детали отказа).
const NOTE_FIELD = 'UF_CRM_1752737600889';
const CATEGORY_NAME = { '0': 'Продажи', '1': 'Сервис', '2': 'Расходники', '3': 'Обучение' };

function resolveReason(raw) {
  if (raw == null || raw === '' || raw === false) return null;
  const arr = Array.isArray(raw) ? raw : [raw];
  const names = arr.map(v => REASON_MAP[String(v)] || null).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

// Классификация стадии проигрыша по названию: Заморожена / Провалена / (иное).
function classifyStage(name) {
  const n = String(name || '').toLowerCase();
  if (/заморож/.test(n)) return 'Заморожена';
  if (/провал|проигр|lose|отказ|apolog/.test(n)) return 'Провалена';
  return name || 'Проигрыш';
}

// Карта стадий сделок: STATUS_ID → { name, semantic }. Кэш 6ч.
// crm.status.list отдаёт названия стадий (в отличие от меток пользовательских полей).
let _stageCache = null, _stageAt = 0;
async function getStageMap() {
  if (_stageCache && Date.now() - _stageAt < 6 * 3600 * 1000) return _stageCache;
  const map = {};
  try {
    let start = 0;
    while (true) {
      const { result, next } = await b24('crm.status.list', {
        filter: {}, select: ['ENTITY_ID', 'STATUS_ID', 'NAME', 'SEMANTICS'], start,
      });
      for (const s of (result || [])) {
        if (!/^DEAL_STAGE/.test(String(s.ENTITY_ID || ''))) continue;
        map[String(s.STATUS_ID)] = { name: s.NAME || s.STATUS_ID, semantic: s.SEMANTICS || null };
      }
      if (next === undefined || next === null) break;
      start = next;
    }
    _stageCache = map; _stageAt = Date.now();
  } catch (e) {
    console.error('getStageMap error:', e.message);
    _stageCache = map; _stageAt = Date.now();
  }
  return map;
}

async function getLostDeals(days = 7) {
  const d = Math.max(1, Math.min(90, parseInt(days, 10) || 7));
  const sinceMs = Date.now() - d * 86400 * 1000;
  const since = new Date(sinceMs).toISOString().slice(0, 19) + '+00:00';

  const [rate, stageMap] = await Promise.all([getTodayRate().catch(() => 0), getStageMap()]);
  const nmeRate = rate || 0;

  // Стадии-проигрыши: семантика 'F' ИЛИ название содержит «заморож/провал/проигр»
  // (на случай, если «Заморожена» настроена как стадия воронки, а не финальная 'F').
  const lostStageIds = Object.entries(stageMap)
    .filter(([, v]) => v.semantic === 'F' || /заморож|провал|проигр/i.test(v.name || ''))
    .map(([id]) => id);

  // Тянем сделки по этим стадиям, изменённые за окно. Если карта стадий не
  // прочиталась (пусто) — надёжный фолбэк на семантический фильтр 'F'.
  const filter = lostStageIds.length
    ? { STAGE_ID: lostStageIds, '>=DATE_MODIFY': since }
    : { STAGE_SEMANTIC_ID: 'F', '>=DATE_MODIFY': since };
  const select = ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
    'ASSIGNED_BY_ID', 'CREATED_BY_ID', 'DATE_MODIFY', REASON_FIELD, NOTE_FIELD];

  let items = [], start = 0;
  while (true) {
    const { result, next } = await b24('crm.deal.list', { filter, select, order: { DATE_MODIFY: 'DESC' }, start });
    items = items.concat(result || []);
    if (next === undefined || next === null) break;
    start = next;
  }

  const deals = items.map(x => {
    const sum = parseFloat(x.OPPORTUNITY) || 0;
    const cur = x.CURRENCY_ID || 'KZT';
    const sumKzt = cur === 'USD' ? sum * nmeRate : sum;
    const st = stageMap[String(x.STAGE_ID)] || { name: x.STAGE_ID };
    const stageType = classifyStage(st.name);
    const reason = resolveReason(x[REASON_FIELD]);
    const note = (x[NOTE_FIELD] && String(x[NOTE_FIELD]).trim()) || null;
    const aid = x.ASSIGNED_BY_ID ? String(x.ASSIGNED_BY_ID) : null;
    const cid = x.CREATED_BY_ID ? String(x.CREATED_BY_ID) : null;
    return {
      id: Number(x.ID),
      title: x.TITLE || ('#' + x.ID),
      category: CATEGORY_NAME[String(x.CATEGORY_ID)] || ('Воронка ' + x.CATEGORY_ID),
      stage: x.STAGE_ID, stageName: st.name, stageType,
      sum, currency: cur, sumKzt,
      manager: aid ? (USERS[aid] || ('#' + aid)) : '—', managerId: aid,
      creator: cid ? (USERS[cid] || ('#' + cid)) : '—', creatorId: cid,
      reason: reason || '(причина не указана)', hasReason: !!reason, note,
      date: x.DATE_MODIFY ? String(x.DATE_MODIFY).slice(0, 10) : null,
    };
  });

  const agg = (keyFn) => {
    const m = {};
    for (const dl of deals) { const k = keyFn(dl); const r = m[k] = m[k] || { key: k, n: 0, sumKzt: 0 }; r.n++; r.sumKzt += dl.sumKzt; }
    return Object.values(m).sort((a, b) => b.n - a.n);
  };
  const byType = agg(x => x.stageType).map(r => ({ type: r.key, n: r.n, sumKzt: r.sumKzt }));
  const byReason = agg(x => x.reason).map(r => ({ reason: r.key, n: r.n, sumKzt: r.sumKzt }));
  const byManager = agg(x => x.manager).map(r => ({ manager: r.key, n: r.n, sumKzt: r.sumKzt }));
  const totalKzt = deals.reduce((s, x) => s + x.sumKzt, 0);

  return { ok: true, days: d, count: deals.length, totalKzt, rate: nmeRate, deals, byType, byReason, byManager };
}

module.exports = { getLostDeals };

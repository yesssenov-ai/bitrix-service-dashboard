// Фаза 2 Статистики — сбор истории стадий сделок из Битрикс.
// crm.stagehistory.list отдаёт по строке на КАЖДЫЙ вход сделки в стадию
// (с датой). Складываем в ticketsmodule_stage_history — и по ней считаем
// реальные конверсии между стадиями и время на каждой стадии.
//
// Бэкфилл идемпотентен (ON CONFLICT (id) DO NOTHING): можно жать кнопку
// повторно — подтянутся только новые записи, дубли не создаются.
const fetch = require('node-fetch');
const { b24 } = require('./bitrix');
const { pool } = require('./auth');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Прогресс живёт в процессе — фронт опрашивает /api/stats/backfill-status.
let _running = false;
let _progress = { running: false, fetched: 0, inserted: 0, pages: 0, done: false, error: null, variant: null, startedAt: null, finishedAt: null };
function status() { return { ..._progress, running: _running }; }

// Разные порталы Битрикса капризны к параметрам crm.stagehistory.list
// (order/select/имя entityTypeId). Пробуем набор вариантов — минимальный
// первым — и запоминаем первый рабочий.
const VARIANTS = [
  { entityTypeId: 'deal' },
  { entityTypeId: 'deal', order: { ID: 'ASC' } },
  { entityTypeId: 2 },
  { entity_type_id: 'deal' },
];
let _variant = null;

async function callPage(start) {
  if (_variant) return b24('crm.stagehistory.list', { ..._variant, start });
  let lastErr;
  for (const v of VARIANTS) {
    try {
      const res = await b24('crm.stagehistory.list', { ...v, start });
      _variant = v; _progress.variant = JSON.stringify(v);
      console.log('stage-history: рабочий вариант параметров —', _progress.variant);
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Прямой вызов ради ТЕКСТА ошибки Битрикса (b24 бросает без тела ответа).
async function probeError() {
  const WEBHOOK = process.env.BITRIX_WEBHOOK;
  if (!WEBHOOK) return 'BITRIX_WEBHOOK не задан';
  try {
    const res = await fetch(`${WEBHOOK}crm.stagehistory.list.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'identity' },
      body: 'entityTypeId=deal&start=0',
    });
    const txt = await res.text();
    return `HTTP ${res.status}: ${txt.slice(0, 400)}`;
  } catch (e) { return 'probe error: ' + e.message; }
}

async function insertBatch(items) {
  if (!items.length) return 0;
  const vals = [], ph = [];
  items.forEach((it, i) => {
    const b = i * 5;
    ph.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
    vals.push(
      Number(it.ID),
      Number(it.OWNER_ID),
      it.CATEGORY_ID != null && it.CATEGORY_ID !== '' ? parseInt(it.CATEGORY_ID, 10) : null,
      it.STAGE_ID || null,
      it.CREATED_TIME || null
    );
  });
  const q = `INSERT INTO ticketsmodule_stage_history (id, deal_id, category_id, stage_id, created_time)
             VALUES ${ph.join(',')} ON CONFLICT (id) DO NOTHING`;
  const r = await pool.query(q, vals);
  return r.rowCount || 0;
}

// Полный бэкфилл истории стадий по всем сделкам (все 4 воронки).
// Fire-and-forget: крутится в фоне, прогресс — в _progress и в логах Railway.
async function backfillStageHistory() {
  if (_running) { console.log('stage-history backfill уже идёт — пропускаю'); return 0; }
  _running = true;
  _variant = null;
  _progress = { running: true, fetched: 0, inserted: 0, pages: 0, done: false, error: null, variant: null, startedAt: Date.now(), finishedAt: null };
  let start = 0, safety = 0;
  try {
    while (true) {
      let resp;
      try {
        resp = await callPage(start);
      } catch (e) {
        // Все варианты параметров упали — вытащим текст ошибки Битрикса в лог/статус.
        const detail = await probeError();
        throw new Error(`${e.message} · ответ Битрикса: ${detail}`);
      }
      const { result, next } = resp;
      const items = Array.isArray(result) ? result : (result && Array.isArray(result.items) ? result.items : []);
      if (items.length) {
        _progress.fetched += items.length;
        _progress.inserted += await insertBatch(items);
      }
      _progress.pages++;
      if (_progress.pages % 20 === 0) {
        const min = ((Date.now() - _progress.startedAt) / 60000).toFixed(1);
        console.log(`  ...история стадий: ${_progress.fetched} записей (${min} мин, страниц ${_progress.pages})`);
      }
      if (next === undefined || next === null) break;
      start = next;
      if (++safety > 20000) { console.warn('stage-history backfill: достигнут предохранитель по числу страниц'); break; }
      await sleep(90); // не упираться в лимит Битрикса
    }
    _progress.done = true;
    const min = ((Date.now() - _progress.startedAt) / 60000).toFixed(1);
    console.log(`✅ История стадий собрана: ${_progress.fetched} записей, добавлено ${_progress.inserted}, за ${min} мин.`);
  } catch (e) {
    _progress.error = e.message;
    console.error('stage-history backfill error:', e.message);
  } finally {
    _running = false;
    _progress.running = false;
    _progress.finishedAt = Date.now();
  }
  return _progress.fetched;
}

module.exports = { backfillStageHistory, status };

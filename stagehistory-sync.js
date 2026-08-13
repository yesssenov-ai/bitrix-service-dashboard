// Фаза 2 Статистики — сбор истории стадий сделок из Битрикс.
// crm.stagehistory.list отдаёт по строке на КАЖДЫЙ вход сделки в стадию
// (с датой). Складываем в ticketsmodule_stage_history — и по ней считаем
// реальные конверсии между стадиями и время на каждой стадии.
//
// Бэкфилл идемпотентен (ON CONFLICT (id) DO NOTHING): можно жать кнопку
// повторно — подтянутся только новые записи, дубли не создаются.
const { b24 } = require('./bitrix');
const { pool } = require('./auth');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SELECT = ['ID', 'OWNER_ID', 'CREATED_TIME', 'CATEGORY_ID', 'STAGE_ID'];

// Прогресс живёт в процессе — фронт опрашивает /api/stats/backfill-status.
let _running = false;
let _progress = { running: false, fetched: 0, inserted: 0, pages: 0, done: false, error: null, startedAt: null, finishedAt: null };
function status() { return { ..._progress, running: _running }; }

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
  _progress = { running: true, fetched: 0, inserted: 0, pages: 0, done: false, error: null, startedAt: Date.now(), finishedAt: null };
  let start = 0, safety = 0;
  try {
    while (true) {
      const { result, next } = await b24('crm.stagehistory.list', {
        entityTypeId: 'deal',
        order: { ID: 'ASC' },
        select: SELECT,
        start,
      });
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

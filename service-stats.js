// ── Зеркало сервисных заявок (1058) для статистики Планировщика ──────────────
// Отдельная таблица со ВСЕМИ заявками на сервис — завершёнными и нет, любого
// типа услуг. Нужна потому, что в самом планировщике живут только «готовые»
// события, а завершённые подготовительные (Подбор/Подготовка/Чек-лист) из него
// удаляются — и в отчёт по живым событиям уже не попадают. Зеркало наполняется
// из той же фоновой сверки, что и планировщик (по одному проходу crm.item.list),
// плюс точечно из вебхука. Командировку (есть/согласована) проставляет проход
// по 1074 (у неё parentId1058).
const { pool } = require('./auth');
const { USERS } = require('./constants');
const { SERVICE_TYPE_MAP, AREA_MAP } = require('./bitrix-lookups');
const { getCompanyName } = require('./bitrix-lookups');
const { getStageSemantics } = require('./relations');

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_service_stats (
    bitrix_item_id    BIGINT PRIMARY KEY,
    title             TEXT,
    engineer_id       INTEGER,
    engineer_name     VARCHAR(200),
    company_id        INTEGER,
    company_name      VARCHAR(400),
    service_type_ids  INTEGER[],
    service_type_labels TEXT,
    start_date        DATE,
    end_date          DATE,
    category_id       INTEGER,
    stage_id          VARCHAR(80),
    is_completed      BOOLEAN DEFAULT FALSE,
    completion        CHAR(1),          -- S=успех, F=провал/отказ, P=в работе
    has_trip          BOOLEAN DEFAULT FALSE,
    trip_approved     BOOLEAN DEFAULT FALSE,
    area              VARCHAR(200),
    city              VARCHAR(200),
    created_time      TIMESTAMPTZ,
    updated_time      TIMESTAMPTZ,
    synced_at         TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_svcstats_engineer ON ticketsmodule_service_stats(engineer_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_svcstats_dates ON ticketsmodule_service_stats(start_date, end_date)');
  schemaReady = true;
}

function toDateOnly(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Апсерт одной заявки 1058 в зеркало по «сырому» элементу Битрикса.
// has_trip / trip_approved НЕ трогаем — их ставит проход по командировкам (1074).
async function upsertFromItem(item, itemId) {
  await ensureSchema();
  try {
    const id = Number(itemId || item.id);
    if (!id) return;
    const engineerId = parseInt(item.ufCrm8_1732856367, 10) || null;
    const engineerName = engineerId ? (USERS[engineerId] || null) : null;
    const svcIds = Array.isArray(item.ufCrm8_1744300223)
      ? item.ufCrm8_1744300223.map(Number).filter(Boolean)
      : (item.ufCrm8_1744300223 ? [Number(item.ufCrm8_1744300223)] : []);
    const svcLabels = svcIds.map(s => SERVICE_TYPE_MAP[s] || String(s)).join(', ');
    const companyId = parseInt(item.companyId, 10) || null;
    let companyName = null;
    if (companyId) { try { companyName = await getCompanyName(companyId); } catch (e) {} }
    const startDate = toDateOnly(item.ufCrm8_1764742554715);
    const endDate = toDateOnly(item.ufCrm8_1764742724958);
    const categoryId = parseInt(item.categoryId, 10) || null;
    const stageId = item.stageId || null;
    let completion = 'P';
    try { completion = await getStageSemantics(1058, item.categoryId, item.stageId); } catch (e) { completion = 'P'; }
    const isCompleted = completion === 'S' || completion === 'F';
    const areaIds = Array.isArray(item.ufCrm8_1732855428) ? item.ufCrm8_1732855428 : (item.ufCrm8_1732855428 ? [item.ufCrm8_1732855428] : []);
    const area = areaIds.length ? (AREA_MAP[areaIds[0]] || null) : null;
    const city = item.ufCrm8_1732855494458 || null;
    const createdTime = item.createdTime || null;
    const updatedTime = item.updatedTime || null;

    await pool.query(
      `INSERT INTO ticketsmodule_service_stats
         (bitrix_item_id, title, engineer_id, engineer_name, company_id, company_name,
          service_type_ids, service_type_labels, start_date, end_date, category_id, stage_id,
          is_completed, completion, area, city, created_time, updated_time, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
       ON CONFLICT (bitrix_item_id) DO UPDATE SET
         title=$2, engineer_id=$3, engineer_name=$4, company_id=$5, company_name=$6,
         service_type_ids=$7, service_type_labels=$8, start_date=$9, end_date=$10,
         category_id=$11, stage_id=$12, is_completed=$13, completion=$14,
         area=$15, city=$16, created_time=$17, updated_time=$18, synced_at=NOW()`,
      [id, item.title || '', engineerId, engineerName, companyId, companyName,
       svcIds.length ? svcIds : null, svcLabels, startDate, endDate, categoryId, stageId,
       isCompleted, completion, area, city, createdTime, updatedTime]
    );
  } catch (e) { console.error('service-stats upsert error:', e.message); }
}

// Пометить у заявки наличие командировки (и согласована ли). Вызывается из
// прохода по 1074: parentId1058 → родительская заявка.
async function markTrip(parentId1058, approved) {
  if (!parentId1058) return;
  await ensureSchema();
  try {
    await pool.query(
      'UPDATE ticketsmodule_service_stats SET has_trip=TRUE, trip_approved=$2 WHERE bitrix_item_id=$1',
      [Number(parentId1058), !!approved]
    );
  } catch (e) { console.error('service-stats markTrip error:', e.message); }
}

async function removeStat(itemId) {
  await ensureSchema();
  try { await pool.query('DELETE FROM ticketsmodule_service_stats WHERE bitrix_item_id=$1', [Number(itemId)]); }
  catch (e) { console.error('service-stats remove error:', e.message); }
}

// ── Выборка для отчёта ───────────────────────────────────────────────────────
// filters: { from, to, engineerIds[], serviceTypeIds[], completed('any'|'yes'|'no'),
//            hasTrip('any'|'yes'|'no'), tripApproved('any'|'yes'|'no') }
// allowedEngineerIds: null = все; иначе Set/массив разрешённых bitrix-id (скоуп роли).
async function query(filters = {}, allowedEngineerIds = null) {
  await ensureSchema();
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$?', '$' + params.length)); };

  // Пересечение периодов: заявка попадает, если её интервал пересекает [from,to].
  if (filters.from) add('(end_date IS NULL OR end_date >= $?)', filters.from);
  if (filters.to) add('(start_date IS NULL OR start_date <= $?)', filters.to);

  if (Array.isArray(filters.engineerIds) && filters.engineerIds.length) {
    add('engineer_id = ANY($?::int[])', filters.engineerIds.map(Number).filter(Boolean));
  }
  if (Array.isArray(filters.serviceTypeIds) && filters.serviceTypeIds.length) {
    add('service_type_ids && $?::int[]', filters.serviceTypeIds.map(Number).filter(Boolean));
  }
  if (filters.completed === 'yes') where.push('is_completed = TRUE');
  else if (filters.completed === 'no') where.push('is_completed = FALSE');

  if (filters.hasTrip === 'yes') where.push('has_trip = TRUE');
  else if (filters.hasTrip === 'no') where.push('has_trip = FALSE');

  if (filters.tripApproved === 'yes') where.push('trip_approved = TRUE');
  else if (filters.tripApproved === 'no') where.push('trip_approved = FALSE');

  // Скоуп роли: ограничить разрешёнными инженерами.
  if (allowedEngineerIds) {
    const ids = Array.from(allowedEngineerIds).map(Number).filter(Boolean);
    if (!ids.length) return { rows: [], summary: emptySummary() };
    params.push(ids);
    where.push('engineer_id = ANY($' + params.length + '::int[])');
  }

  const sql = `SELECT bitrix_item_id, title, engineer_id, engineer_name, company_name,
      service_type_ids, service_type_labels, start_date, end_date, category_id, stage_id,
      is_completed, completion, has_trip, trip_approved, area, city, created_time, updated_time
    FROM ticketsmodule_service_stats
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY start_date DESC NULLS LAST, bitrix_item_id DESC
    LIMIT 5000`;
  const { rows } = await pool.query(sql, params);

  // Сводка
  const summary = emptySummary();
  summary.total = rows.length;
  for (const r of rows) {
    if (r.is_completed) summary.completed++; else summary.open++;
    if (r.has_trip) summary.withTrip++; else summary.withoutTrip++;
    // дни (включительно)
    let days = 1;
    if (r.start_date && r.end_date) {
      const s = new Date(r.start_date), e = new Date(r.end_date);
      days = Math.max(1, Math.round((e - s) / 86400000) + 1);
    }
    summary.totalDays += days;
    // по типу услуг (каждый тип заявки учитываем отдельно)
    const labels = (r.service_type_labels || '').split(',').map(x => x.trim()).filter(Boolean);
    for (const lbl of labels) summary.byType[lbl] = (summary.byType[lbl] || 0) + 1;
    // по сотруднику
    if (r.engineer_name) summary.byEngineer[r.engineer_name] = (summary.byEngineer[r.engineer_name] || 0) + 1;
  }
  return { rows, summary };
}

function emptySummary() {
  return { total: 0, completed: 0, open: 0, withTrip: 0, withoutTrip: 0, totalDays: 0, byType: {}, byEngineer: {} };
}

module.exports = { ensureSchema, upsertFromItem, markTrip, removeStat, query };

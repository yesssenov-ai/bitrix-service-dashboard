// Справочник отделов (id → название), синхронизируемый из Битрикса (department.get).
// Нужен, чтобы агент и модули могли фильтровать сделки по НАЗВАНИЮ отдела
// (в сделках хранится только department_id). Таблица создаётся идемпотентно и
// засевается известными метками, чтобы названия работали ещё до первой синхронизации.
const { pool } = require('./auth');

// Сид из исторически известных отделов (совпадает с DEPARTMENT_LABELS в stats2-calc).
const SEED = {
  '4857': 'Элементный', '4858': 'Хроматография', '4859': 'Электрохимия',
  '4860': 'Клеточный анализ', '4862': 'ОРМ', '4863': 'Сервис',
  '4864': 'Тренинг-центр', '4865': 'General Lab', '4866': 'Комплекс', '8384': 'Материаловедение',
};

let _ready = null;
async function ensureDeptTable() {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_departments (
      id VARCHAR(40) PRIMARY KEY,
      name VARCHAR(200),
      parent_id VARCHAR(40),
      synced_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // Засев известных меток (не перетирает более свежие данные Битрикса).
    for (const [id, name] of Object.entries(SEED)) {
      await pool.query(`INSERT INTO ticketsmodule_departments (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [id, name]);
    }
  })();
  return _ready;
}

// Справочник сотрудников (id → ФИО, без персональных данных) — чтобы агент мог
// фильтровать сделки по менеджеру (в сделках assigned_by_id = bitrix_user_id).
// Наполняется из ticketsmodule_users (безопасные колонки, без паролей/телефонов).
async function refreshStaffRef() {
  await pool.query(`CREATE TABLE IF NOT EXISTS ticketsmodule_staff_ref (
    id INTEGER PRIMARY KEY,
    name VARCHAR(200),
    username VARCHAR(100),
    bitrix_user_id INTEGER,
    job_title VARCHAR(200),
    active BOOLEAN,
    synced_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`INSERT INTO ticketsmodule_staff_ref (id, name, username, bitrix_user_id, job_title, active, synced_at)
    SELECT id, display_name, username, bitrix_user_id, job_title, active, NOW() FROM ticketsmodule_users
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, username=EXCLUDED.username,
      bitrix_user_id=EXCLUDED.bitrix_user_id, job_title=EXCLUDED.job_title, active=EXCLUDED.active, synced_at=NOW()`);
  const n = (await pool.query('SELECT COUNT(*)::int c FROM ticketsmodule_staff_ref')).rows[0].c;
  return { ok: true, staff: n };
}

// Полная синхронизация из Битрикса (department.get, с пагинацией).
async function syncDepartments() {
  await ensureDeptTable();
  const { b24 } = require('./bitrix');
  let start = 0, total = 0;
  for (let i = 0; i < 50; i++) {
    const res = await b24('department.get', { start });
    const list = (res && res.result) || [];
    for (const d of list) {
      const id = String(d.ID);
      const name = String(d.NAME || '').slice(0, 200);
      const parent = (d.PARENT != null && d.PARENT !== '') ? String(d.PARENT) : null;
      await pool.query(`INSERT INTO ticketsmodule_departments (id, name, parent_id, synced_at)
        VALUES ($1,$2,$3,NOW()) ON CONFLICT (id) DO UPDATE SET name=$2, parent_id=$3, synced_at=NOW()`,
        [id, name, parent]);
      total++;
    }
    if (res && res.next != null) start = res.next; else break;
  }
  return { ok: true, synced: total };
}

// Синхронизировать всё разом (отделы из Битрикса + справочник сотрудников из БД).
async function syncRefs() {
  const out = { ok: true };
  try { out.departments = (await syncDepartments()).synced; } catch (e) { out.deptError = e.message; }
  try { out.staff = (await refreshStaffRef()).staff; } catch (e) { out.staffError = e.message; }
  return out;
}

// При загрузке: создаём/засеваем таблицы, затем фоном синхронизируем.
ensureDeptTable()
  .then(() => refreshStaffRef().catch(e => console.warn('staff ref (фон):', e.message)))
  .then(() => syncDepartments().catch(e => console.warn('departments sync (фон):', e.message)))
  .catch(e => console.error('departments ensure:', e.message));

module.exports = { ensureDeptTable, syncDepartments, refreshStaffRef, syncRefs, SEED };

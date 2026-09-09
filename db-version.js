// Дешёвая «версия» содержимого таблицы для опроса на изменения.
//
// Проблема: страницы ЦУП тихо опрашивают сервер по таймеру и тянут ПОЛНЫЕ данные
// (SELECT * ...), просто чтобы понять, изменилось ли что-то. Это гонит из Supabase
// наружу (egress) одни и те же мегабайты десятки раз в час — на бесплатном тарифе
// это и съедало квоту.
//
// Решение: version-эндпоинт вызывает эту функцию, которая считает лёгкий маркер
// содержимого ВНУТРИ Postgres (COUNT + порядко-независимая сумма построчных
// хэшей). Наружу уходит несколько байт. Фронт тянет полные данные только когда
// маркер изменился. Сумма хэшей не зависит от порядка строк и от имён колонок —
// любое добавление/удаление/правка строки меняет маркер.
const { pool } = require('./auth');

// Разрешённые таблицы (значение подставляется в SQL, поэтому — строгий белый список).
const ALLOWED = new Set([
  'ticketsmodule_procurement',
  'ticketsmodule_stat_deals',
  'ticketsmodule_mail_emails',
  'ticketsmodule_planner_events',
]);

async function tableVersion(table) {
  if (!ALLOWED.has(table)) throw new Error('tableVersion: table not allowed: ' + table);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::bigint AS n,
            COALESCE(SUM(('x' || substr(md5(t::text), 1, 8))::bit(32)::int), 0)::text AS h
       FROM ${table} t`
  );
  const r = rows[0] || {};
  return String(r.n || 0) + ':' + String(r.h || 0);
}

module.exports = { tableVersion };

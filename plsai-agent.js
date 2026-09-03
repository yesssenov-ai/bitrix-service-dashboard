// ProLab AI — агент с доступом к данным ЦУПа (шаг 1: карта данных + безопасный
// read-only SQL-инструмент + tool-calling через Claude Messages API).
//
// Идея: вместо захардкоженных «дорожек» под каждый вопрос модель получает КАРТУ
// доступных таблиц-зеркал и один инструмент run_sql (только SELECT). Она сама
// решает, откуда и как достать данные, и в каком виде показать ответ.
//
// Безопасность и «результаты согласно ролям»:
//  • Только SELECT/WITH, одиночный запрос, read-only транзакция + statement_timeout.
//  • Таблицы с учётками/PII (пароли, 2FA, telegram, уведомления) — заблокированы
//    для всех, даже админа (нет аналитической ценности).
//  • Клиентский PII / финансы (почта, рассылки, план контрактов) — только
//    admin/coordinator/manager.
//  • Остальные бизнес-таблицы видны по ГРАНТУ модуля (как и сами модули в ЦУПе):
//    нет доступа к модулю — агент не пустит в его таблицы.
//  • Сделки (stat_deals): непривилегированные роли видят только сделки своего
//    отдела (как canCommentDeal в модуле «План продаж»); привилегированные — все.

const { pool } = require('./auth');
const { EMPLOYEE_DEPT } = require('./dept-map');

// Пул для запросов агента. Если задан PLSAI_READONLY_DATABASE_URL (отдельная роль
// Postgres только на чтение) — используем его (принцип наименьших привилегий).
// Иначе — основной пул, но каждый запрос всё равно идёт в READ ONLY транзакции.
let _roPool = null;
function agentPool() {
  if (_roPool) return _roPool;
  const url = process.env.PLSAI_READONLY_DATABASE_URL;
  if (!url) { _roPool = pool; return _roPool; }
  try {
    const { Pool } = require('pg');
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    _roPool = new Pool({ connectionString: url, ssl, max: 3 });
  } catch (e) { _roPool = pool; }
  return _roPool;
}

const AGENT_MODEL = process.env.PLSAI_AGENT_MODEL || process.env.PLSAI_MODEL || 'claude-3-5-haiku-latest';
const MAX_STEPS = parseInt(process.env.PLSAI_AGENT_MAX_STEPS || '8', 10);
const ROW_CAP = 2000;          // жёсткий потолок строк в SQL
const ROWS_TO_MODEL = 40;      // сколько строк отдаём модели обратно
const STMT_TIMEOUT_MS = 9000;

const PRIVILEGED = new Set(['admin', 'coordinator', 'manager']);

// ── Карта данных ────────────────────────────────────────────────────────────
// tier: 'blocked' | 'privileged' | 'ref' | module-code (строка).
// owner: колонка Bitrix-менеджера для построчного ограничения непривилегированным.
const TABLE_META = {
  // Учётки / безопасность / PII — заблокировано для всех.
  ticketsmodule_users:            { tier: 'blocked' },
  ticketsmodule_webauthn_creds:   { tier: 'blocked' },
  ticketsmodule_login_attempts:   { tier: 'blocked' },
  ticketsmodule_telegram_links:   { tier: 'blocked' },
  ticketsmodule_push_subs:        { tier: 'blocked' },
  ticketsmodule_user_prefs:       { tier: 'blocked' },
  ticketsmodule_module_access:    { tier: 'blocked' },
  ticketsmodule_audit_logs:       { tier: 'blocked' },
  ticketsmodule_notification_log: { tier: 'blocked' },

  // Клиентский PII / финансы — только admin/coordinator/manager.
  ticketsmodule_mail_emails:            { tier: 'privileged', desc: 'входящие письма (модуль Почта): классификация, статусы ответов' },
  ticketsmodule_mail_rules:             { tier: 'privileged', desc: 'правила разбора почты' },
  ticketsmodule_mail_learned_patterns:  { tier: 'privileged', desc: 'обученные шаблоны разбора почты' },
  ticketsmodule_ticket_emails:          { tier: 'privileged', desc: 'письма по сервисным заявкам' },
  ticketsmodule_campaigns:              { tier: 'privileged', desc: 'массовые рассылки: кампании' },
  ticketsmodule_campaign_recipients:    { tier: 'privileged', desc: 'получатели рассылок (email клиентов)' },
  ticketsmodule_campaign_audience:      { tier: 'privileged', desc: 'аудитории рассылок' },
  ticketsmodule_campaign_suppression:   { tier: 'privileged', desc: 'стоп-лист рассылок' },
  ticketsmodule_contract_plan:          { tier: 'privileged', desc: 'план по контрактам (модуль Контракты)' },
  ticketsmodule_plsai_history:          { tier: 'privileged', desc: 'история запросов ProLab AI' },
  ticketsmodule_plsai_comment_meta:     { tier: 'privileged', desc: 'мета по комментариям сделок (ProLab AI)' },
  ticketsmodule_plsai_comment_signal:   { tier: 'privileged', desc: 'сигналы по комментариям сделок' },
  ticketsmodule_plsai_pipeline_snap:    { tier: 'privileged', desc: 'снимки воронки продаж по месяцам' },

  // Сделки — построчно по отделу для непривилегированных.
  ticketsmodule_stat_deals: { tier: ['SALE', 'STATS'], owner: 'assigned_by_id', desc: 'ЗЕРКАЛО СДЕЛОК CRM: сумма (opportunity/currency), стадия (stage_id), менеджер (assigned_by_id), отдел (department_id), производитель (manufacturer), прибор (instrument), компания (company_name), планируемая дата покупки (planned_purchase_date), дата договора (real_contract_date), признак «наиболее вероятная» (likely_deal), даты (date_create, install_date, warranty_end)' },
  ticketsmodule_stage_history: { tier: ['SALE', 'STATS'], desc: 'история смены стадий сделок' },

  // Бизнес-таблицы по гранту модуля.
  ticketsmodule_procurement:            { tier: 'PROC', desc: 'закупки: заявки (title, stage_id, accountant_bid, deal_id, payload с суммой/комментарием/ответственным)' },
  ticketsmodule_procurement_audit:      { tier: 'PROC', desc: 'аудит удалённых закупок' },
  ticketsmodule_procurement_files:      { tier: 'PROC', desc: 'файлы закупок (метаданные; без содержимого)' },
  ticketsmodule_procurement_deal_ship:  { tier: 'PROC', desc: 'отгрузки по сделкам закупок' },
  ticketsmodule_procurement_ship_files: { tier: 'PROC', desc: 'файлы отгрузок закупок' },
  ticketsmodule_procurement_autoseen:   { tier: 'PROC', desc: 'служебное: авто-создание закупок' },
  ticketsmodule_operational_deals:      { tier: 'OPS', desc: 'реализация: сделки после подписания (воронка исполнения)' },
  ticketsmodule_operational_detail:     { tier: 'OPS', desc: 'реализация: детали по сделкам' },
  ticketsmodule_operational_meta:       { tier: 'OPS', desc: 'реализация: мета' },
  ticketsmodule_operational_perms:      { tier: 'OPS', desc: 'реализация: права' },
  ticketsmodule_ops_report_snapshot:    { tier: 'OPS', desc: 'реализация: снимки отчёта' },
  ticketsmodule_kp_requests:            { tier: 'KP', desc: 'КП/МЛК: заявки на коммерческие предложения' },
  ticketsmodule_kp_request_categories:  { tier: 'KP', desc: 'КП: категории заявки и назначенные эксперты (expert_ids)' },
  ticketsmodule_kp_line_items:          { tier: 'KP', desc: 'КП: позиции' },
  ticketsmodule_kp_categories:          { tier: 'KP', desc: 'КП: справочник категорий' },
  ticketsmodule_kp_items:               { tier: 'KP', desc: 'КП: каталог позиций' },
  ticketsmodule_kp_catalog_versions:    { tier: 'KP', desc: 'КП: версии каталога' },
  ticketsmodule_kp_comments:            { tier: 'KP', desc: 'КП: комментарии' },
  ticketsmodule_planner_events:         { tier: 'PLN', desc: 'планировщик: выезды/командировки инженеров' },
  ticketsmodule_planner_config:         { tier: 'PLN', desc: 'планировщик: конфиг' },
  ticketsmodule_planner_datafields:     { tier: 'PLN', desc: 'планировщик: поля' },
  ticketsmodule_equipment_geo:          { tier: 'EQP', desc: 'карта оборудования: гео установленной базы' },
  ticketsmodule_equipment_meta:         { tier: 'EQP', desc: 'оборудование: мета' },
  ticketsmodule_equipment_cache:        { tier: 'EQP', desc: 'оборудование: кэш' },
  ticketsmodule_licenses_geo:           { tier: 'LIC', desc: 'карта лицензий ГМК: недропользователи' },
  ticketsmodule_nct_drafts:             { tier: 'NKT', desc: 'НКТ: черновики регистрации товаров' },
  ticketsmodule_bonus_tariff_categories:{ tier: 'BONUS', desc: 'бонусы инженеров: тарифные категории' },
  ticketsmodule_project_clients:        { tier: 'PROJ', desc: 'проекты (БДМ): справочник клиент→БДМ→группа' },
  ticketsmodule_logistics_notified:     { tier: 'LOG', desc: 'логистика: уже уведомлённые заказы' },

  // Справочники — доступны всем авторизованным (без PII).
  ticketsmodule_exchange_rates:              { tier: 'ref', desc: 'курсы валют (для пересчёта в тенге)' },
  ticketsmodule_instrument_category_map:     { tier: 'ref', desc: 'справочник: прибор → категория' },
  ticketsmodule_stat_instrument_manufacturer:{ tier: 'ref', desc: 'справочник: прибор → производитель' },
  ticketsmodule_place_geo:                   { tier: 'ref', desc: 'кэш геокодинга адресов' },
  ticketsmodule_notified_overdue:            { tier: 'ref', desc: 'служебное: уже уведомлённые просрочки' },
};

// Кому какие таблицы доступны на чтение агентом.
function allowedTablesFor(user, moduleCodes) {
  const role = user && user.role;
  const isAdmin = role === 'admin';
  const isPriv = PRIVILEGED.has(role);
  const codes = moduleCodes; // null = все (админ), либо Set кодов
  const has = code => codes === null || (codes && codes.has(code));
  const out = new Set();
  for (const [t, m] of Object.entries(TABLE_META)) {
    if (m.tier === 'blocked') continue;                 // никогда
    if (m.tier === 'ref') { out.add(t); continue; }     // справочники — всем
    if (m.tier === 'privileged') { if (isPriv) out.add(t); continue; }
    // tier — код модуля или массив кодов: по гранту (админ — всё)
    const mods = Array.isArray(m.tier) ? m.tier : [m.tier];
    if (isAdmin || mods.some(has)) out.add(t);
  }
  return out;
}

// Диапазон Bitrix-id менеджеров, чьи сделки видны непривилегированному
// пользователю (свой отдел). null = без ограничения (привилегированные/админ).
function ownerScopeBids(user, bid) {
  if (PRIVILEGED.has(user && user.role)) return null;
  const b = bid != null ? parseInt(bid, 10) : null;
  if (!b) return [-1];                                   // не связан с Bitrix — ничего своего
  const myDept = EMPLOYEE_DEPT[b];
  if (!myDept) return [b];                               // отдел неизвестен — только свои
  const peers = Object.entries(EMPLOYEE_DEPT).filter(([, d]) => d === myDept).map(([k]) => parseInt(k, 10));
  if (!peers.includes(b)) peers.push(b);
  return peers;
}

// ── Безопасный SELECT ───────────────────────────────────────────────────────
const SQL_KEYWORDS = new Set(['where', 'on', 'using', 'join', 'inner', 'left', 'right', 'full', 'cross', 'natural', 'group', 'order', 'having', 'limit', 'offset', 'union', 'except', 'intersect', 'as', 'and', 'or', 'window', 'for', 'fetch', 'lateral']);
// Опасные операции/функции. Слова подобраны так, чтобы НЕ ловить обычные колонки
// (created_at, updated_at, comment, deleted и т.п. — по границе слова не совпадут).
// Основную защиту всё равно даёт: запрос обязан начинаться с SELECT/WITH, быть
// одиночным (без «;») и выполняться в READ ONLY транзакции (БД отклонит любую запись).
// Опасные функции / системные каталоги (в SELECT им не место).
const FORBIDDEN = /\b(pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_ls_logdir|pg_stat_file|lo_import|lo_export|dblink|set_config|current_setting|information_schema|pg_catalog|pg_class|pg_attribute|pg_authid|pg_shadow|pg_roles|pg_user)\b/i;
// Пишущие операции (в т.ч. внутри writable-CTE). Паттерны с \s+ не ловят обычные
// колонки created_at/updated_at/comment (там нет пробела после ключевого слова).
const WRITE = /(\binsert\s+into|\bupdate\s+\w|\bdelete\s+from|\bdrop\s+\w|\balter\s+\w|\btruncate\b|\bcreate\s+\w|\bgrant\s+\w|\brevoke\s+\w|\bmerge\s+into|\bcopy\s+\w|\bvacuum\b|\breindex\b)/i;

function extractTables(sql) {
  const tables = new Set();
  const re = /\b(?:from|join)\s+"?([a-zA-Z_][a-zA-Z0-9_$.]*)"?/gi;
  let m;
  while ((m = re.exec(sql))) {
    let name = m[1].toLowerCase();
    if (name.includes('.')) name = name.split('.').pop();
    tables.add(name);
  }
  return tables;
}

// Ограничение по отделу для sensitive-таблиц: заменяем ссылку на таблицу
// подзапросом с фильтром, сохраняя алиас (или подставляя имя таблицы как алиас).
function injectOwnerScope(sql, table, ownerCol, bids) {
  const arr = 'ARRAY[' + bids.map(x => parseInt(x, 10)).filter(n => !isNaN(n)).join(',') + ']::bigint[]';
  const sub = `(SELECT * FROM ${table} WHERE ${ownerCol} = ANY(${arr}))`;
  const re = new RegExp('(\\bfrom\\s+|\\bjoin\\s+)' + table + '\\b(\\s+(?:as\\s+)?([a-zA-Z_][a-zA-Z0-9_]*))?', 'gi');
  return sql.replace(re, (full, kw, aliasPart, alias) => {
    // Настоящий алиас (не ключевое слово) — сохраняем его.
    if (alias && !SQL_KEYWORDS.has(alias.toLowerCase())) return `${kw}${sub} ${alias}`;
    // Иначе алиасом становится имя таблицы, а «проглоченный» хвост (например
    // « WHERE …» или « ON …») возвращаем на место — иначе потеряем условие.
    return `${kw}${sub} ${table}${aliasPart || ''}`;
  });
}

function ensureLimit(sql) {
  if (/\blimit\s+\d+/i.test(sql)) {
    return sql.replace(/\blimit\s+(\d+)/i, (m, n) => 'LIMIT ' + Math.min(parseInt(n, 10) || ROW_CAP, ROW_CAP));
  }
  return sql.replace(/;?\s*$/, '') + ` LIMIT ${ROW_CAP}`;
}

async function guardedSelect(rawSql, ctx) {
  let sql = String(rawSql || '').trim().replace(/;+\s*$/, '');
  if (!sql) throw new Error('Пустой SQL');
  if (/;/.test(sql)) throw new Error('Разрешён только один запрос (без «;»)');
  if (!/^(select|with)\b/i.test(sql)) throw new Error('Разрешён только SELECT/WITH');
  if (WRITE.test(sql)) throw new Error('Разрешено только чтение (SELECT)');
  if (FORBIDDEN.test(sql)) throw new Error('В запросе есть запрещённые функции/каталоги');

  const refs = extractTables(sql);
  for (const t of refs) {
    if (!t.startsWith('ticketsmodule_')) throw new Error(`Недоступная таблица: ${t}`);
    if (!ctx.allowed.has(t)) throw new Error(`Нет доступа к таблице «${t}» для вашей роли`);
  }
  // Построчное ограничение по отделу.
  if (ctx.ownerBids) {
    for (const t of refs) {
      const meta = TABLE_META[t];
      if (meta && meta.owner) sql = injectOwnerScope(sql, t, meta.owner, ctx.ownerBids);
    }
  }
  sql = ensureLimit(sql);

  const client = await agentPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STMT_TIMEOUT_MS}`);
    const r = await client.query(sql);
    await client.query('ROLLBACK');
    return { rows: r.rows || [], rowCount: r.rowCount || (r.rows ? r.rows.length : 0), sql };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ── Системный промпт (карта + правила + роль) ───────────────────────────────
function buildSystem(user, allowed) {
  const lines = [];
  for (const t of [...allowed].sort()) {
    const m = TABLE_META[t] || {};
    lines.push(`- ${t}${m.desc ? ' — ' + m.desc : ''}`);
  }
  return [
    'Ты — ProLab AI, аналитический помощник по системе ЦУП (ProLabSupport). Отвечай по-русски, кратко и по делу.',
    `Пользователь: ${user.display_name || user.engineer_name || 'сотрудник'} · роль: ${user.role}.`,
    '',
    'У тебя есть инструмент run_sql — выполнить ОДИН SELECT (только чтение) к базе-зеркалу ЦУПа (Postgres).',
    'Данные — это зеркало Bitrix и модулей ЦУПа. Суммы почти везде в валюте сделки; для пересчёта в тенге используй ticketsmodule_exchange_rates при необходимости.',
    'Тебе доступны ТОЛЬКО эти таблицы (доступ уже отфильтрован по твоей роли и грантам модулей — не пытайся обращаться к другим):',
    ...lines,
    '',
    'Правила:',
    '1) Чтобы ответить на вопрос о данных — вызывай run_sql. Не выдумывай числа; бери их только из результата запроса.',
    '2) Только SELECT/WITH, один запрос, без «;». Всегда ставь разумный LIMIT.',
    '3) Работай ЭКОНОМНО: обычно хватает 1–2 запросов. Колонки таблицы не знаешь — сделай ОДИН «SELECT * FROM <таблица> LIMIT 3», дальше сразу строй нужный агрегат. Не делай лишних запросов.',
    '4) Доступ уже ограничен по роли на уровне БД. Если запрос отклонён по правам («нет доступа к таблице») — НЕ повторяй его, а честно скажи пользователю, что по его роли этих данных нет.',
    '5) Формат ответа: сначала короткий вывод словами. Если уместно — компактная таблица в Markdown (до ~15 строк). Большие выборки — предложи сузить.',
    '6) Не раскрывай пароли, токены, телефоны, e-mail — таких таблиц у тебя и нет.',
    '',
    'Подсказки по данным (чтобы не тратить шаги):',
    '• ЗАКУПКИ (ticketsmodule_procurement): текущая стадия — колонка stage_id. Значения: DT1066_13:NEW=Новая заявка, DT1066_13:PREPARATION=Запрос счёта, DT1066_13:CLIENT=Договор, DT1066_13:1=Согласование, DT1066_13:2=Оплата закупки, DT1066_13:UC_QO83IP=Ожидание товара, DT1066_13:SUCCESS=Товар принят. Сумма и детали лежат в JSON-поле payload: сумма = (payload->>\'opportunity\')::numeric, валюта = payload->>\'currency\', ответственный (Bitrix-id) = payload->>\'assigned\', комментарий бухгалтера = payload->>\'payComment\'. Пример «сколько закупок на этапе оплаты и на какую сумму»: SELECT count(*) AS n, sum((payload->>\'opportunity\')::numeric) AS summa FROM ticketsmodule_procurement WHERE stage_id=\'DT1066_13:2\'.',
    '• СДЕЛКИ (ticketsmodule_stat_deals): сумма = opportunity (валюта currency), стадия = stage_id, менеджер = assigned_by_id, отдел = department_id, дата покупки = planned_purchase_date, «наиболее вероятная» = likely_deal (boolean).',
    '• КП/МЛК (ticketsmodule_kp_requests): статус заявки — колонка status (draft/in_review/needs_revision/approved), клиент = client_name, создана = created_at.',
  ].join('\n');
}

// ── Инструмент для Claude ───────────────────────────────────────────────────
const TOOLS = [{
  name: 'run_sql',
  description: 'Выполнить один SELECT (только чтение) к базе-зеркалу ЦУПа и получить строки результата. Возвращает до 40 строк.',
  input_schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'Одиночный SELECT/WITH запрос PostgreSQL, без «;».' },
      purpose: { type: 'string', description: 'Кратко: что достаём (для лога).' },
    },
    required: ['sql'],
  },
}];

async function callClaude(system, messages, key) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: AGENT_MODEL, max_tokens: 1500, system, tools: TOOLS, messages }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error((data && data.error && data.error.message) || ('HTTP ' + r.status));
  return data;
}

function trimRows(rows) {
  const shown = rows.slice(0, ROWS_TO_MODEL).map(row => {
    const o = {};
    for (const [k, v] of Object.entries(row)) {
      if (v == null) { o[k] = v; continue; }
      if (typeof v === 'object') { const s = JSON.stringify(v); o[k] = s.length > 300 ? s.slice(0, 300) + '…' : s; }
      else { const s = String(v); o[k] = s.length > 300 ? s.slice(0, 300) + '…' : v; }
    }
    return o;
  });
  return shown;
}

// ── Главная функция: прогнать вопрос через агента ───────────────────────────
async function runAgent(qRaw, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY не задан' };
  const q = String(qRaw || '').trim().slice(0, 1000);
  if (!q) return { ok: false, error: 'Пустой запрос' };

  const { userModuleCodes } = require('./auth');
  const codes = await userModuleCodes(user);         // null = все (админ)
  const allowed = allowedTablesFor(user, codes);
  const meBid = (function () {
    if (user && user.bitrix_user_id) return parseInt(user.bitrix_user_id, 10);
    const nm = user && (user.engineer_name || user.display_name);
    if (nm) { try { const { USERS } = require('./constants'); const f = Object.entries(USERS).find(([, n]) => n === nm); if (f) return parseInt(f[0], 10); } catch (_) {} }
    return null;
  })();
  const ownerBids = ownerScopeBids(user, meBid);
  const ctx = { allowed, ownerBids };

  const system = buildSystem(user, allowed);
  const messages = [{ role: 'user', content: q }];
  const steps = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    let data;
    try { data = await callClaude(system, messages, key); }
    catch (e) { return { ok: false, error: 'Модель недоступна: ' + e.message, steps }; }

    const toolUses = (data.content || []).filter(c => c.type === 'tool_use');
    const textParts = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();

    if (!toolUses.length) {
      return { ok: true, answer: textParts || 'Готово.', steps, model: AGENT_MODEL };
    }

    // Есть вызовы инструмента — выполняем и возвращаем результаты модели.
    messages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name !== 'run_sql') { toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Неизвестный инструмент', is_error: true }); continue; }
      const sql = tu.input && tu.input.sql;
      try {
        const res = await guardedSelect(sql, ctx);
        steps.push({ purpose: (tu.input && tu.input.purpose) || '', sql: res.sql, rowCount: res.rowCount });
        const shown = trimRows(res.rows);
        const note = res.rowCount > ROWS_TO_MODEL ? `\n(показаны первые ${ROWS_TO_MODEL} из ${res.rowCount})` : '';
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: `rowCount=${res.rowCount}\n${JSON.stringify(shown)}${note}` });
      } catch (e) {
        steps.push({ purpose: (tu.input && tu.input.purpose) || '', sql: String(sql || ''), error: e.message });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: 'Ошибка выполнения: ' + e.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Шаги исчерпаны — принуждаем модель дать ЛУЧШИЙ ответ по уже полученным данным
  // (без инструментов), а не отдавать сухое «не удалось завершить».
  messages.push({ role: 'user', content: 'Заверши: дай лучший возможный ответ по уже полученным данным. Если данных не хватило или нет доступа — коротко объясни почему. Не вызывай инструменты.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: AGENT_MODEL, max_tokens: 1200, system, messages }),
    });
    const data = await r.json();
    if (r.ok) {
      const txt = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (txt) return { ok: true, answer: txt, steps, model: AGENT_MODEL, truncated: true };
    }
  } catch (e) { /* ниже общий ответ */ }
  // Совсем не получилось — покажем, что мешало (ошибки запросов), чтобы было понятно.
  const errs = steps.filter(s => s.error).slice(-2).map(s => s.error);
  const tail = errs.length ? ' Причина: ' + errs.join('; ') + '.' : '';
  return { ok: true, answer: 'Пока не получилось собрать ответ по этому вопросу.' + tail + ' Попробуй сформулировать точнее.', steps, model: AGENT_MODEL, truncated: true };
}

module.exports = { runAgent, allowedTablesFor, ownerScopeBids, guardedSelect, TABLE_META };

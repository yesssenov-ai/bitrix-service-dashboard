-- Роль Postgres ТОЛЬКО НА ЧТЕНИЕ для ProLab AI (переменная PLSAI_READONLY_DATABASE_URL).
-- Второй слой защиты: даже если проверка запросов в коде агента когда-нибудь
-- ошибётся, база не отдаст закрытые таблицы и не даст ничего записать.
--
-- Списки ниже сгенерированы из TABLE_META и BLOCK_PARTS в plsai-agent.js.
-- Скрипт идемпотентен: запускайте ПОВТОРНО после появления новых таблиц —
-- новые таблицы по умолчанию закрыты для роли, пока не выдан SELECT.
--
-- Запуск: Supabase → SQL Editor → вставить файл как есть → Run. Пароль — отдельной командой (см. ниже).

-- ПАРОЛЬ В ЭТОТ ФАЙЛ НЕ ВПИСЫВАТЬ: репозиторий публичный. Пароль задаётся ОДНОЙ
-- отдельной командой прямо в SQL Editor и нигде не сохраняется:
--     ALTER ROLE plsai_ro PASSWORD 'ваш-пароль';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plsai_ro') THEN
    CREATE ROLE plsai_ro LOGIN;
  END IF;
END $$;

ALTER ROLE plsai_ro SET default_transaction_read_only = on;
ALTER ROLE plsai_ro SET statement_timeout = '10s';
ALTER ROLE plsai_ro SET search_path = public;

GRANT USAGE ON SCHEMA public TO plsai_ro;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM plsai_ro;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM plsai_ro;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM plsai_ro;

DO $$
DECLARE
  t text;
  blocked text[] := ARRAY[
    'ticketsmodule_users',
    'ticketsmodule_webauthn_creds',
    'ticketsmodule_login_attempts',
    'ticketsmodule_telegram_links',
    'ticketsmodule_push_subs',
    'ticketsmodule_user_prefs',
    'ticketsmodule_module_access',
    'ticketsmodule_audit_logs',
    'ticketsmodule_notification_log',
    'ticketsmodule_tg_link_codes',
    'ticketsmodule_tg_updates',
    'ticketsmodule_tg_turns',
    'ticketsmodule_user_google',
    'ticketsmodule_agent_actions',
    'ticketsmodule_agent_reminders',
    'ticketsmodule_msg_messages',
    'ticketsmodule_msg_reactions',
    'ticketsmodule_msg_played',
    'ticketsmodule_msg_presence'
  ];
  -- таблицы, чьё имя похоже на секретное, но они описаны в карте агента как рабочие
  allowed_override text[] := ARRAY[
    'ticketsmodule_procurement_audit'
  ];
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'ticketsmodule\_%' LOOP
    IF t = ANY(blocked) THEN CONTINUE; END IF;
    IF NOT (t = ANY(allowed_override))
       AND substring(t from 15) ~ '(^|_)(users?|webauthn|logins?|passwords?|tokens?|secrets?|creds?|credentials|sessions?|link_codes|google|telegram|tg|push|prefs|audit|agent|otp|totp|keys?)(_|$)' THEN CONTINUE; END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO plsai_ro', t);
  END LOOP;
END $$;

-- RLS. На таблицах с включённой защитой строк (Supabase часто её включает) роль
-- без разрешающего правила видит 0 строк — без ошибки. Даём правило «читать всё»
-- ТОЛЬКО этой роли и ТОЛЬКО там, где выше выдан SELECT. Закрытые таблицы не трогаем.
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relrowsecurity
       AND c.relname LIKE 'ticketsmodule\_%'
       AND has_table_privilege('plsai_ro', c.oid, 'SELECT')
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname = 'plsai_ro_read') THEN
      EXECUTE format('CREATE POLICY plsai_ro_read ON public.%I FOR SELECT TO plsai_ro USING (true)', t);
    END IF;
  END LOOP;
END $$;

-- Проверка (должно быть: false, false, true):
SELECT has_table_privilege('plsai_ro', 'public.ticketsmodule_users', 'SELECT')      AS users_readable,
       has_table_privilege('plsai_ro', 'public.ticketsmodule_stat_deals', 'INSERT') AS deals_writable,
       has_table_privilege('plsai_ro', 'public.ticketsmodule_stat_deals', 'SELECT') AS deals_readable;

-- Строка подключения для Railway (PLSAI_READONLY_DATABASE_URL) — как DATABASE_URL,
-- но с пользователем plsai_ro. Через пулер Supabase имя пользователя пишется
-- как plsai_ro.<project-ref> (project-ref — та же часть, что в имени пользователя
-- postgres.<project-ref> в вашей текущей DATABASE_URL).

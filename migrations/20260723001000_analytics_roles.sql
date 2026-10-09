-- Least-privilege warehouse roles for dbt + Lightdash (CLAUDE.md Analytics
-- Stack, sihha D2). CI/dbt/Lightdash never hold the superuser credential.
--
--   dbt_writer        — SELECT on the whitelisted raw source tables; OWNS the
--                       `analytics` schema (dbt materializes its models there).
--   lightdash_reader  — SELECT on `analytics` only; can read nothing raw.
--
-- SECRETS ARE NOT IN GIT. Roles are created WITH LOGIN but WITHOUT a password;
-- the operator sets them out of band on the server:
--   ALTER ROLE dbt_writer       WITH PASSWORD '...';
--   ALTER ROLE lightdash_reader WITH PASSWORD '...';
-- (For local dev over trust/peer auth no password is needed.)
--
-- Roles are cluster-global, so creation is guarded to stay idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dbt_writer') THEN
    CREATE ROLE dbt_writer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lightdash_reader') THEN
    CREATE ROLE lightdash_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- The analytics schema is dbt_writer's workspace.
CREATE SCHEMA IF NOT EXISTS analytics AUTHORIZATION dbt_writer;

-- dbt_writer reads the raw ingestion tables (whitelist — grant per table so a
-- new raw table is a deliberate addition here, never automatic).
GRANT USAGE ON SCHEMA public TO dbt_writer;
GRANT SELECT ON
  public.runs,
  public.lifting_sessions,
  public.lifting_exercises,
  public.lifting_sets,
  public.fueling_products,
  public.run_fueling_items,
  public.planned_sessions,
  public.nutrition_days,
  public.body_metrics,
  public.qualitative_logs
TO dbt_writer;

-- lightdash_reader sees ONLY the analytics schema.
GRANT USAGE ON SCHEMA analytics TO lightdash_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO lightdash_reader;

-- Future tables dbt_writer creates in analytics are auto-readable by Lightdash.
ALTER DEFAULT PRIVILEGES FOR ROLE dbt_writer IN SCHEMA analytics
  GRANT SELECT ON TABLES TO lightdash_reader;

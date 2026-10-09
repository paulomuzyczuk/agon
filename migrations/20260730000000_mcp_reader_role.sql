-- Least-privilege read role for the MCP consulting layer (CLAUDE.md build order:
-- "MCP/consulting layer"). Mirrors the analytics_roles pattern. The MCP server
-- already enforces read-only via READ ONLY transactions (services/mcp/readonlyDb.ts);
-- this role is DB-level defense in depth so MCP_DATABASE_URL can point at an
-- account that physically cannot write.
--
-- SECRETS ARE NOT IN GIT. Created WITH LOGIN but no password; set it out of band:
--   ALTER ROLE mcp_reader WITH PASSWORD '...';
-- (Local dev over trust/peer auth needs no password; MCP_DATABASE_URL may also
-- just reuse DATABASE_URL locally.)
--
-- Roles are cluster-global, so creation is guarded to stay idempotent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_reader') THEN
    CREATE ROLE mcp_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Read the public ingestion tables. SELECT on ALL current + FUTURE tables in
-- public: unlike dbt_writer's deliberate whitelist, the consulting layer should
-- see whatever data exists, and it's read-only regardless.
GRANT USAGE ON SCHEMA public TO mcp_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_reader;

-- SECURITY: the consulting layer must NOT be able to read OAuth secrets (refresh
-- tokens). Revoke the token tables from the blanket grant. The app layer also
-- denies these tables (services/mcp/sql.ts) so the local DATABASE_URL fallback is
-- protected too.
REVOKE ALL ON public.google_health_oauth_tokens FROM mcp_reader;
REVOKE ALL ON public.google_calendar_oauth_tokens FROM mcp_reader;

-- mcp_reader otherwise has no INSERT/UPDATE/DELETE/DDL and no analytics access.

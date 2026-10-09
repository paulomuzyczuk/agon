-- Strava ingestion bookkeeping. Landed as its own migration (after the core
-- schema) to demonstrate the incremental discipline: the first ingestion path
-- adds only what it needs, it doesn't reopen the schema migration.
--
-- Single-user platform, so a single token row suffices. The one-row invariant is
-- enforced with a fixed-id PK pattern (see services/strava/oauth.ts, which
-- always upserts id = TRUE). access_token is short-lived (~6h); refresh_token is
-- the durable credential and is why this must be persisted rather than re-run
-- through the browser consent each time.
CREATE TABLE public.strava_oauth_tokens (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),  -- singleton row
  athlete_id    BIGINT NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,     -- absolute expiry of access_token
  scope         TEXT,                     -- granted scopes, e.g. 'read,activity:read_all'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_strava_oauth_tokens_touch BEFORE UPDATE ON public.strava_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- The backfill service also needs the token table (it refreshes + rewrites it).
GRANT SELECT ON public.strava_oauth_tokens TO dbt_writer;

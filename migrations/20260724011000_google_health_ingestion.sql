-- Google Health API ingestion (Run Ingestion Pivot, CLAUDE.md 2026-07-24). The
-- new primary live run source: runs recorded on the Fitbit Air + phone
-- connected-GPS, read server-side via the Google Health REST API (Google OAuth2).
--
-- Single-user platform, so one token row — the same singleton pattern as
-- strava_oauth_tokens / fitbit_oauth_tokens (services/googleHealth/oauth.ts always
-- upserts id = TRUE). The Google Health API addresses the authenticated user as
-- `users/me`, so no provider user-id column is needed here. access_token is
-- short-lived; refresh_token (returned only on the first consent with
-- access_type=offline&prompt=consent) is the durable credential, hence persisted.
--
-- The runs / run_streams tables already admit source 'google_health' (added in
-- 20260724010000_run_identity_and_google_health.sql), so no run-table change here.
CREATE TABLE public.google_health_oauth_tokens (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),  -- singleton row
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,     -- absolute expiry of access_token
  scope         TEXT,                     -- granted scopes
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_google_health_oauth_tokens_touch BEFORE UPDATE ON public.google_health_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

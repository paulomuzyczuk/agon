-- Strava best-efforts reference data (2026-08-05). A one-time, time-boxed pull
-- enabled by a gifted month of Strava premium reopening API access. Strava is NOT
-- a live source (see CLAUDE.md Run Ingestion Pivot); this table captures
-- paywall-only ground truth I can't get once premium lapses.
--
-- Strava's detailed-activity endpoint (`GET /activities/{id}?include_all_efforts=
-- true`) returns a `best_efforts[]` array for each run: the best split at every
-- standard distance (400m / 1k / 1 mile / 5k / 10k / Half-Marathon / Marathon /
-- …) achieved WITHIN that activity. There is no all-time-PR endpoint, so we store
-- every activity's efforts raw here and let the dbt mart (fct_run_best_efforts)
-- derive the per-distance PR (min elapsed) — which is also the source of the
-- athlete's own best-effort PAIRS for recalibrating the Riegel exponent
-- (Premium-Parity #2 PR predictions).
--
-- EXPAND phase only (migrations/README.md): a fresh reference table, nothing
-- destroyed. Idempotent on (strava_activity_id, effort_name): a re-pull refreshes
-- the same effort in place (Strava may recompute an effort), never duplicates.
CREATE TABLE public.strava_best_efforts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strava_activity_id  BIGINT NOT NULL,          -- the activity the effort came from
  effort_name         TEXT NOT NULL,            -- Strava's label, e.g. '5k', '10k', 'Half-Marathon'
  distance_m          NUMERIC(9,2) NOT NULL CHECK (distance_m > 0),  -- effort distance (metres)
  elapsed_time_s      INT NOT NULL CHECK (elapsed_time_s > 0),       -- the split time (what a PR ranks on)
  moving_time_s       INT CHECK (moving_time_s > 0),
  pr_rank             INT,                       -- Strava's rank within the activity (1 = activity best); nullable
  started_at          TIMESTAMPTZ,               -- effort start (best_effort.start_date, UTC)
  activity_started_at TIMESTAMPTZ,               -- parent activity start (for dating the PR)
  source              TEXT NOT NULL DEFAULT 'strava' CHECK (source = 'strava'),
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when this reference pull ran
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (strava_activity_id, effort_name)
);

-- Query axis for the PR rollup: fastest split at each named distance.
CREATE INDEX idx_strava_best_efforts_name_time
  ON public.strava_best_efforts (effort_name, elapsed_time_s);

CREATE TRIGGER trg_strava_best_efforts_touch BEFORE UPDATE ON public.strava_best_efforts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.strava_best_efforts IS
  'One-time Strava-premium reference pull: per-activity best_efforts. PR rollup lives in analytics.fct_run_best_efforts. Strava is not a live source.';

-- Whitelisted raw source for dbt (mirrors 20260723001000_analytics_roles.sql —
-- a new raw source table is a deliberate GRANT, never automatic).
GRANT SELECT ON public.strava_best_efforts TO dbt_writer;

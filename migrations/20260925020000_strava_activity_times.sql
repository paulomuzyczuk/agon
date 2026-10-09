-- Strava moving/elapsed time reference data (2026-09-25, MZY-40). A time-boxed
-- pull while a Strava premium window has API access open again (the API is
-- paywalled per developer since 2026-06-30). Strava is NOT a live source; this
-- table captures paywall-only ground truth, same pattern as
-- strava_best_efforts (migrations/20260805010000_strava_best_efforts.sql).
--
-- Why: Strava's `moving_time` (its own auto-pause) and `elapsed_time` exist
-- ONLY in the paywalled API, not in any free export (docs/methodology-log.md
-- 2026-09-05, "GPX export field inventory"). Agon estimates moving time
-- in-house (lib/movingTime.ts::computeMovingTime over `moving` /
-- `derived_moving`); this table is the reference those estimates are
-- reconciled against (`pnpm strava:times`).
--
-- One row per Strava run/ride activity. run_id / ride_id link the activity to
-- the Agon row it describes (a source='strava' row directly, or a
-- google_health run matched by time overlap — services/strava/matchEnrich.ts).
-- Both are nullable: an activity with no confident match is still kept as
-- reference data.
--
-- EXPAND phase only (migrations/README.md): a fresh reference table, nothing
-- destroyed. Idempotent on strava_activity_id: a re-pull refreshes in place.
CREATE TABLE public.strava_activity_times (
  strava_activity_id  BIGINT PRIMARY KEY,
  activity_kind       TEXT NOT NULL CHECK (activity_kind IN ('run', 'ride')),
  sport_type          TEXT,                      -- Strava's sport_type, e.g. 'Run', 'TrailRun', 'Ride'
  started_at          TIMESTAMPTZ NOT NULL,      -- activity start_date (UTC)
  distance_m          NUMERIC(9,1) CHECK (distance_m >= 0),
  moving_time_s       INT NOT NULL CHECK (moving_time_s >= 0),   -- Strava's auto-pause-corrected time
  elapsed_time_s      INT NOT NULL CHECK (elapsed_time_s >= 0),  -- wall clock, start to finish
  run_id              UUID REFERENCES public.runs (id) ON DELETE SET NULL,
  ride_id             UUID REFERENCES public.rides (id) ON DELETE SET NULL,
  captured_at         TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when this reference pull ran
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (run_id IS NULL OR ride_id IS NULL)
);

CREATE INDEX idx_strava_activity_times_run_id
  ON public.strava_activity_times (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX idx_strava_activity_times_ride_id
  ON public.strava_activity_times (ride_id) WHERE ride_id IS NOT NULL;

CREATE TRIGGER trg_strava_activity_times_touch BEFORE UPDATE ON public.strava_activity_times
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.strava_activity_times IS
  'Strava-premium reference pull (MZY-40): per-activity moving_time/elapsed_time, linked to runs/rides. Ground truth for reconciling lib/movingTime.ts estimates. Strava is not a live source.';

-- Whitelisted raw source for dbt (a new raw source table is a deliberate
-- GRANT, never automatic). mcp_reader gets SELECT via its default privileges.
GRANT SELECT ON public.strava_activity_times TO dbt_writer;

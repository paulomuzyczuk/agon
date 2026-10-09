-- Source-agnostic best efforts (superseding strava_best_efforts as the LIVE
-- input to race predictions — see docs/race-prediction-pipeline planning
-- notes and CLAUDE.md). public.strava_best_efforts was a ONE-TIME pull during
-- a gifted month of Strava premium (2026-08-05); Strava live sync stays
-- retired, so that table is frozen (newest row 2026-08-01) and every run since
-- (Google Health live sync + manual Telegram entries) was invisible to the
-- Riegel-exponent recalibration.
--
-- This table is derived directly from Agon's own runs/run_streams by
-- lib/bestEfforts.ts + scripts/backfill-best-efforts.ts (`pnpm be:backfill`),
-- independent of Strava, so any source feeds the model going forward:
--
--   * method='stream'    — a sliding-window search over a distance-bearing
--     run_streams row (source 'strava' or 'google_health'; 'fitbit' streams
--     are HR-only) finds the fastest elapsed time to cover each standard
--     bucket distance anywhere in the run, plus the run's own full distance.
--   * method='whole_run' — no distance-bearing stream exists (e.g. a manual
--     Telegram long run with no GPS track): the run's own distance_km/
--     duration_s stands in as a single, coarser "the pace they ran" data
--     point for that run's OWN distance (effort_name='full_run' only).
--
-- Grain: one row per (run_id, effort_name). 'full_run' is keyed by run_id, so
-- it is NEVER deduped away across runs — every run contributes its own
-- long-distance anchor point for the fatigue-curve fit, whether or not it has
-- a stream. Named bucket distances stay a per-distance PR search across the
-- whole history, same idea as strava_best_efforts.
--
-- EXPAND phase only (migrations/README.md): a fresh table; strava_best_efforts
-- is untouched and remains the frozen historical/paywall-only reference.
CREATE TABLE public.run_best_efforts (
  run_id         UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  effort_name    TEXT NOT NULL,          -- bucket name (e.g. '5K') or 'full_run'
  distance_m     NUMERIC(9,2) NOT NULL CHECK (distance_m > 0),
  elapsed_time_s NUMERIC(8,1) NOT NULL CHECK (elapsed_time_s > 0),
  method         TEXT NOT NULL CHECK (method IN ('stream', 'whole_run')),
  stream_source  TEXT,                   -- run_streams.source used (NULL for whole_run)
  achieved_at    TIMESTAMPTZ,            -- the run's date, for dating a PR
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, effort_name)
);

-- Query axis for the PR rollup (fastest split per bucket) and for the
-- full_run per-distance-bin dedup done in services/racePrediction.ts.
CREATE INDEX idx_run_best_efforts_name_time
  ON public.run_best_efforts (effort_name, elapsed_time_s);

CREATE TRIGGER trg_run_best_efforts_touch BEFORE UPDATE ON public.run_best_efforts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.run_best_efforts IS
  'Source-agnostic best efforts derived from runs/run_streams by lib/bestEfforts.ts. Feeds fct_race_predictions, superseding strava_best_efforts as the live input.';

-- Whitelisted raw source for dbt (mirrors every prior derived table, e.g.
-- 20260805020000_run_relative_effort.sql).
GRANT SELECT ON public.run_best_efforts TO dbt_writer;

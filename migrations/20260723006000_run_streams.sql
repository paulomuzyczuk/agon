-- Whole-run time series (compact-array storage, decided 2026-07-23). One row per
-- (run, source): the arrays are INDEX-ALIGNED — element i of every array is the
-- same sample, positioned in time by time_s[i]. Analytics UNNESTs them WITH
-- ORDINALITY when it needs per-point work (HR drift, pace:HR decoupling,
-- time-in-zone); most of the time the whole curve is fetched as one cheap row.
--
-- PK is (run_id, source) so a run can hold HR from more than one sensor later
-- (e.g. a Strava chest-strap series AND a Fitbit wrist series) without collision.
CREATE TABLE public.run_streams (
  run_id              UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  source              TEXT NOT NULL
                        CHECK (source IN ('strava', 'fitbit', 'garmin', 'polar')),
  time_s              INT[] NOT NULL,       -- seconds from activity start (the alignment axis)
  heartrate           INT[],                -- bpm
  distance_m          NUMERIC[],            -- cumulative distance
  altitude_m          NUMERIC[],
  cadence             INT[],
  velocity_smooth_mps NUMERIC[],            -- instantaneous speed (m/s) -> pace
  moving              BOOLEAN[],            -- false during auto-pauses
  sample_count        INT NOT NULL CHECK (sample_count >= 0),
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source)
);
CREATE TRIGGER trg_run_streams_touch BEFORE UPDATE ON public.run_streams
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.run_streams TO dbt_writer;

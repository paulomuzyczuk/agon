-- Bike ride tracking (2026-09-10 — the athlete bought a bike; CLAUDE.md
-- Premium-Parity #6 already has cycling routes and planned_sessions already
-- admits 'bike' sessions, but nothing captured an actual RIDE once one
-- happened). `rides` is a sibling table to `runs`, not a generalized
-- polymorphic "activities" table — same precedent as `lifting_sessions`
-- being fully separate from `runs`, and bikes use speed, not pace, so the
-- run-specific columns (avg_pace_s_per_km, pain_*, shoe_used) don't map
-- cleanly onto cycling.
--
-- Mirrors public.runs (migrations/20260723000000_core_schema.sql) and its
-- later EXPAND passes: same (source, external_id) idempotency key, same
-- weather columns, same qualitative-field shape. `avg_speed_kmh`/
-- `max_speed_kmh` replace `avg_pace_s_per_km`. `bike_used` mirrors
-- `runs.shoe_used` (denormalized name; structured gear lives in ride_gear,
-- see the next migration).
CREATE TABLE public.rides (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date                DATE NOT NULL,
  started_at          TIMESTAMPTZ,
  start_lat           NUMERIC,
  start_lng           NUMERIC,
  block               INT,
  week                INT,
  distance_km         NUMERIC(7,3) NOT NULL CHECK (distance_km > 0),
  duration_s          INT NOT NULL CHECK (duration_s > 0),
  avg_hr              INT CHECK (avg_hr BETWEEN 0 AND 260),
  max_hr              INT CHECK (max_hr BETWEEN 0 AND 260),
  avg_speed_kmh       NUMERIC(6,2) CHECK (avg_speed_kmh > 0),
  max_speed_kmh       NUMERIC(6,2) CHECK (max_speed_kmh > 0),
  elevation_gain_m    NUMERIC(7,1),
  bike_used           TEXT,                 -- denormalized bike name; structured link lives in ride_gear
  perceived_effort    INT CHECK (perceived_effort BETWEEN 1 AND 10),
  general_notes       TEXT,
  -- Source-agnostic idempotency key, same design as runs (source, external_id) —
  -- see migrations/20260724010000_run_identity_and_google_health.sql.
  external_id         TEXT,
  source              TEXT NOT NULL CHECK (source IN (
                         'strava', 'polar', 'telegram', 'manual', 'google_health',
                         'samsung_export', 'garmin_export', 'strava_export', 'live_recording'
                       )),
  origin              TEXT,                 -- upstream platform within `source`, e.g. google_health -> 'health_connect' | 'fitbit'
  -- weather enrichment (Open-Meteo), joined on start time + GPS:
  temp_c              NUMERIC(4,1),
  humidity_pct        NUMERIC(5,2) CHECK (humidity_pct BETWEEN 0 AND 100),
  wind_kph            NUMERIC(5,1) CHECK (wind_kph >= 0),
  weather_conditions  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rides_date ON public.rides (date);
CREATE UNIQUE INDEX idx_rides_source_external_id
  ON public.rides (source, external_id);
CREATE TRIGGER trg_rides_touch BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.rides TO dbt_writer;

-- Ride time-series storage, mirroring public.run_streams (migrations/
-- 20260723006000_run_streams.sql + its later GPS-track EXPAND pass at
-- 20260805000000_run_streams_gps_track.sql) exactly: index-aligned sample
-- arrays keyed on (ride_id, source), lat/lng included from the start since
-- the ingestion paths that will write here (Strava streams, Google Health
-- TCX export) always produce a route array. `derived_moving`/
-- `fitbit_cadence` are NOT included — those are run-specific stop-detection
-- refinements (lib/movingTime.ts cadence cross-checks) out of scope here.
CREATE TABLE public.ride_streams (
  ride_id             UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  source              TEXT NOT NULL
                        CHECK (source IN (
                          'strava', 'fitbit', 'garmin', 'polar', 'google_health',
                          'samsung_export', 'garmin_export', 'strava_export', 'live_recording'
                        )),
  time_s              INT[] NOT NULL,       -- seconds from activity start (the alignment axis)
  heartrate           INT[],                -- bpm
  distance_m          NUMERIC[],            -- cumulative distance
  altitude_m          NUMERIC[],
  cadence             INT[],                -- pedal cadence (rpm) where available
  velocity_smooth_mps NUMERIC[],            -- instantaneous speed (m/s) -> speed_kmh
  moving               BOOLEAN[],           -- false during auto-pauses
  lat                 NUMERIC[],
  lng                 NUMERIC[],
  sample_count        INT NOT NULL CHECK (sample_count >= 0),
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ride_id, source)
);
CREATE TRIGGER trg_ride_streams_touch BEFORE UPDATE ON public.ride_streams
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.ride_streams TO dbt_writer;

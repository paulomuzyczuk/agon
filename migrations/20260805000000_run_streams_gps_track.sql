-- GPS route track for run_streams (2026-08-05). The Strava premium window
-- reopened API access to the per-activity Streams endpoint, which carries the
-- `latlng` polyline the athlete's phone recorded. run_streams already stores the
-- index-aligned HR/altitude/pace/cadence series; this adds the two coordinate
-- arrays so the full route is stored alongside them (element i of lat/lng is the
-- same sample as time_s[i]). Enables map rendering and planned-vs-actual GPS
-- comparison against a route_suggestions loop.
--
-- EXPAND phase only (migrations/README.md): both columns are nullable and
-- index-aligned with the existing arrays. Runs with no recorded track (Fitbit Air
-- without a phone GPS trace) simply leave them NULL. Nothing is destroyed.
ALTER TABLE public.run_streams ADD COLUMN lat NUMERIC[];
ALTER TABLE public.run_streams ADD COLUMN lng NUMERIC[];

COMMENT ON COLUMN public.run_streams.lat IS
  'GPS latitude per sample, index-aligned with time_s (NULL when no track recorded).';
COMMENT ON COLUMN public.run_streams.lng IS
  'GPS longitude per sample, index-aligned with time_s (NULL when no track recorded).';

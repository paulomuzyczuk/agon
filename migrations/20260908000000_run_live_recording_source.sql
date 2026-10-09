-- Live activity recording (CLAUDE.md "Live Run Recording"): the browser-side
-- recorder (app/record) buffers samples to IndexedDB during a run and flushes
-- them to Postgres on stop/reconnect. Widens both source vocabularies to admit
-- 'live_recording' — named for the mechanism (this app's own browser-side live
-- capture), not today's one transport (BLE), since a later GPS stream (browser
-- Geolocation, not BLE) would land in the SAME run_streams row (PK run_id+source)
-- alongside the HR array. EXPAND only: widening an IN-list CHECK can't invalidate
-- any existing row. Same shape as 20260724013000_run_file_import_sources.sql.
ALTER TABLE public.runs DROP CONSTRAINT runs_source_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_source_check
  CHECK (source IN (
    'strava', 'polar', 'telegram', 'manual', 'google_health',
    'samsung_export', 'garmin_export', 'strava_export', 'live_recording'
  ));

ALTER TABLE public.run_streams DROP CONSTRAINT run_streams_source_check;
ALTER TABLE public.run_streams ADD CONSTRAINT run_streams_source_check
  CHECK (source IN (
    'strava', 'fitbit', 'garmin', 'polar', 'google_health',
    'samsung_export', 'garmin_export', 'strava_export', 'live_recording'
  ));

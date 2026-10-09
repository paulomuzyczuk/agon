-- Hand-corrected run fields survive re-ingest (2026-09-30) — the runs
-- counterpart of 20260930000000_ride_corrected_fields.sql. `corrected_fields`
-- lists the runs columns the athlete corrected by hand (e.g. distance/duration
-- after a late Strava start); services/strava/ingest.ts upsertRun — shared by
-- Strava, Google Health, file import and live recording — keeps the stored
-- value for each one instead of the source's. Written via
-- services/activityCorrections.ts correctRun().
--
-- EXPAND phase only (migrations/README.md): one new column with a safe
-- default. Nothing corrected yet → '{}'.
ALTER TABLE public.runs
  ADD COLUMN corrected_fields TEXT[] NOT NULL DEFAULT '{}';

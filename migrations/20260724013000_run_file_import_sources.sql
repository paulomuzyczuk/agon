-- File-import run sources (Run Ingestion Pivot, Workstream B — 2026-07-24). The
-- generic GPX/FIT/TCX importer (scripts/import-run-file.ts) is the free, ungated
-- fallback for platforms with no live server API: Samsung Health (on-device SDK
-- only) and Garmin (partner-approval-gated), plus Strava exports. Each imported
-- file lands with `source` set per its origin so a run's provenance is explicit
-- and analytics can weight file imports vs. the live Google Health feed.
--
-- EXPAND only: widening an IN-list CHECK can't invalidate any existing row. The
-- run-identity migration (20260724010000) already foreshadowed these three source
-- tags; this is where they land. run_streams gets the same tags so an imported
-- run's time series stays source-aligned with its run row (PK is run_id+source).
ALTER TABLE public.runs DROP CONSTRAINT runs_source_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_source_check
  CHECK (source IN (
    'strava', 'polar', 'telegram', 'manual', 'google_health',
    'samsung_export', 'garmin_export', 'strava_export'
  ));

ALTER TABLE public.run_streams DROP CONSTRAINT run_streams_source_check;
ALTER TABLE public.run_streams ADD CONSTRAINT run_streams_source_check
  CHECK (source IN (
    'strava', 'fitbit', 'garmin', 'polar', 'google_health',
    'samsung_export', 'garmin_export', 'strava_export'
  ));

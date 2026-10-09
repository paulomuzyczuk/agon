-- Upstream provenance within a `source` (Run Ingestion Pivot follow-up,
-- 2026-07-24). Google Health aggregates runs from several upstream platforms, and
-- they are NOT equal quality: `health_connect` records (a phone app / Samsung /
-- Strava writing into Android Health Connect) match the athlete's SOT to the
-- metre, while `fitbit` records are the Fitbit Air's passive auto-detection —
-- same run, but drifting duration and usually no HR. Verified 2026-07-24 by
-- diffing 97 Google Health runs against the SOT "Event Logging" sheet.
--
-- `origin` stores that upstream platform (lowercased Google Health
-- dataSource.platform) so the ingest can dedupe overlapping records in favor of
-- the SOT-accurate one, and so analytics can weight/exclude the drifty ones.
-- Nullable: only google_health runs carry it today; other sources leave it null.
ALTER TABLE public.runs ADD COLUMN origin TEXT;

COMMENT ON COLUMN public.runs.origin IS
  'Upstream platform within source (e.g. google_health → health_connect | fitbit). '
  'Dedupe prefers health_connect (SOT-accurate) over fitbit (auto-detected).';

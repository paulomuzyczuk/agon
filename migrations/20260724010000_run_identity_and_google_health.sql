-- Run Ingestion Pivot (CLAUDE.md, 2026-07-24): generalize run identity from the
-- Strava-specific strava_activity_id to a source-agnostic (source, external_id),
-- so every non-Strava source (Google Health now, file imports later) can upsert
-- idempotently. Also widens the runs / run_streams source vocabularies to admit
-- 'google_health', the new primary live run source.
--
-- EXPAND phase only (migrations/README.md "Expand → verify → contract"): the new
-- external_id column and its unique index land ALONGSIDE the existing
-- strava_activity_id UNIQUE, which keeps working. A later CONTRACT migration
-- drops strava_activity_id once nothing reads it. Nothing is destroyed here.

-- 1. Source-agnostic external id. Nullable on purpose: manual/telegram runs
--    (services/runs.ts insertManualRun) carry none, and NULLs are distinct in the
--    unique index below, so those rows never collide with each other.
ALTER TABLE public.runs ADD COLUMN external_id TEXT;

-- 2. Backfill: every existing Strava run's external id is its activity id as text.
--    Idempotent (guarded on NULL) so a re-run is a no-op.
UPDATE public.runs
   SET external_id = strava_activity_id::text
 WHERE strava_activity_id IS NOT NULL
   AND external_id IS NULL;

-- 3. The new idempotency key: one run per (source, external_id). upsertRun's
--    ON CONFLICT now targets this index. Rows with a NULL external_id (manual
--    runs) are exempt — Postgres treats NULLs as distinct — which is intended.
CREATE UNIQUE INDEX idx_runs_source_external_id
  ON public.runs (source, external_id);

-- 4. Admit the new primary live source. Widening an IN-list CHECK is safe: no
--    existing row can violate it. Export sources (samsung_export / garmin_export /
--    strava_export) for the generic file importer land with Workstream B.
ALTER TABLE public.runs DROP CONSTRAINT runs_source_check;
ALTER TABLE public.runs ADD CONSTRAINT runs_source_check
  CHECK (source IN ('strava', 'polar', 'telegram', 'manual', 'google_health'));

ALTER TABLE public.run_streams DROP CONSTRAINT run_streams_source_check;
ALTER TABLE public.run_streams ADD CONSTRAINT run_streams_source_check
  CHECK (source IN ('strava', 'fitbit', 'garmin', 'polar', 'google_health'));

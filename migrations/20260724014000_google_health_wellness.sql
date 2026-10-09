-- Google Health wellness migration (Run Ingestion Pivot, Workstream C — 2026-07-24).
-- The legacy Fitbit Web API (services/fitbit/) sunsets September 2026; its
-- daily-activity / resting-HR / sleep / HRV pulls move onto the same Google Health
-- API client already built for runs. This widens the wellness tables to admit the
-- new source and gives sleep a source-agnostic identity (a Google sleep-session id
-- is an opaque string, not the BIGINT log_id Fitbit hands out).
--
-- EXPAND only (migrations/README.md "Expand → verify → contract"): widening an
-- IN-list CHECK can't invalidate any existing row, and the new external_id lands
-- ALONGSIDE the existing (source, log_id) key. Nothing is destroyed here — the
-- legacy Fitbit writers keep working until the Sept 2026 cutover.

-- 1. Admit 'google_health' as a wellness source. Fitbit run HR already lands in
--    run_streams (source 'fitbit'); these three tables hold the all-day + recovery
--    signals that migrate onto Google Health.
ALTER TABLE public.daily_activity DROP CONSTRAINT daily_activity_source_check;
ALTER TABLE public.daily_activity ADD CONSTRAINT daily_activity_source_check
  CHECK (source IN ('fitbit', 'manual', 'google_health'));

ALTER TABLE public.sleep_sessions DROP CONSTRAINT sleep_sessions_source_check;
ALTER TABLE public.sleep_sessions ADD CONSTRAINT sleep_sessions_source_check
  CHECK (source IN ('fitbit', 'manual', 'google_health'));

ALTER TABLE public.hrv_daily DROP CONSTRAINT hrv_daily_source_check;
ALTER TABLE public.hrv_daily ADD CONSTRAINT hrv_daily_source_check
  CHECK (source IN ('fitbit', 'manual', 'google_health'));

-- 2. Source-agnostic sleep identity. Fitbit's numeric log_id can't hold a Google
--    Health sleep-session id (an opaque resource-path segment), so add a TEXT
--    external_id and key google_health sleep on (source, external_id) — the same
--    generalization runs got in 20260724010000. Nullable: existing Fitbit rows
--    keyed on (source, log_id) leave it null until backfilled below.
ALTER TABLE public.sleep_sessions ADD COLUMN external_id TEXT;

-- 3. Backfill existing Fitbit rows so their external id mirrors the log id as text.
--    Idempotent (guarded on NULL) — a re-run is a no-op. Google Health rows will be
--    written with external_id set directly by the ingest.
UPDATE public.sleep_sessions
   SET external_id = log_id::text
 WHERE log_id IS NOT NULL
   AND external_id IS NULL;

-- 4. The new idempotency key: one sleep session per (source, external_id). NULLs
--    are distinct in a Postgres unique index, so Fitbit rows still awaiting the
--    backfill (or manual rows with neither id) never collide.
CREATE UNIQUE INDEX idx_sleep_sessions_source_external_id
  ON public.sleep_sessions (source, external_id);

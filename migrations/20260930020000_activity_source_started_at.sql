-- The source's own start instant, kept when a hand correction moves
-- started_at (MZY-253). A "missed start" correction (the athlete forgot to
-- press start) moves runs/rides.started_at EARLIER by the extrapolated
-- unrecorded time; this column remembers where the source put it.
--
-- Why it's needed:
--   * Stream time origin. run_streams/ride_streams.time_s is relative to the
--     source's start and is never re-fetched, so anything mapping stream
--     samples to wall-clock time uses COALESCE(source_started_at, started_at).
--   * Source-overlap dedupe (MZY-225, services/activitySources.ts). A
--     higher-priority twin supersedes a stored row only when their starts are
--     within 5 min. A twin recorded by another app starts at the source time,
--     not the corrected one, so the match compares against
--     COALESCE(source_started_at, started_at).
--   * Exact revert. Reverting a corrected started_at restores this value
--     directly (no re-sync needed) and clears it.
--
-- NULL = started_at has never been moved by a correction (the common case).
-- Written only by services/activityCorrections.ts.
--
-- EXPAND phase only (migrations/README.md): nullable columns, no backfill.
ALTER TABLE public.runs
  ADD COLUMN source_started_at TIMESTAMPTZ;

ALTER TABLE public.rides
  ADD COLUMN source_started_at TIMESTAMPTZ;

-- In-house moving flag (2026-09-05) — Strava's real `moving` stream is
-- exclusive to its paywalled Streams API (confirmed by inspecting a real free
-- per-activity GPX export, which carries no such field at all — see
-- CLAUDE.md). Every OTHER distance-bearing stream (Google Health, any GPX/TCX
-- file import) therefore never gets a moving flag and can never benefit from
-- computeMovingTime/estimateNetTime (lib/movingTime.ts).
--
-- `derived_moving` is a speed-threshold-derived equivalent
-- (lib/movingTime.ts::deriveMovingFlags), computed for every stream that has
-- a distance_m + time_s pairing, regardless of source. Stored in a SEPARATE
-- column from `moving` (never overwriting it) so the two can always be
-- compared where Strava's real flag is also available
-- (compareMovingFlags / compareConfirmedStops) — validating the heuristic
-- against ground truth rather than just asserting it.
--
-- EXPAND phase only (migrations/README.md): a nullable column on an existing
-- table, nothing destroyed.
ALTER TABLE public.run_streams ADD COLUMN derived_moving BOOLEAN[];

COMMENT ON COLUMN public.run_streams.derived_moving IS
  'In-house speed-threshold moving flag (lib/movingTime.ts::deriveMovingFlags), computed for any distance-bearing stream. Distinct from `moving` (Strava-only, paywalled API) so the two can be compared where both exist.';

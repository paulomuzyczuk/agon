-- Weather provenance flag (2026-09-28, MZY-226). Weather enrichment now also
-- covers activities with NO GPS start (HR-only Agon live recordings, voice-note
-- manual runs) by fetching Open-Meteo for the athlete's configured home
-- location (athlete-profile homeLocation). That weather is an estimate of where
-- the activity happened, not a measurement at its start point, so it's flagged
-- — same idea as runs.avg_hr_estimated. The enrichment re-fetches a flagged row
-- once the activity gains a real GPS start (e.g. a Strava stream attached later).
--
-- EXPAND phase only (migrations/README.md): new columns with a safe default,
-- nothing destroyed. Existing weather was all fetched at a real GPS start → false.
ALTER TABLE public.runs
  ADD COLUMN weather_location_estimated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.rides
  ADD COLUMN weather_location_estimated BOOLEAN NOT NULL DEFAULT false;

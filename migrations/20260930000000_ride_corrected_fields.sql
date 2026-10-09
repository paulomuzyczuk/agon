-- Hand-corrected ride fields survive re-ingest (2026-09-30). The athlete
-- sometimes starts/stops Strava late (e.g. forgot to press start, left it
-- running at home) and corrects the ride's distance/duration by hand. The
-- source upsert (services/strava/rideIngest.ts upsertRide, shared with the
-- Google Health ride ingest) overwrote every summary column on conflict, so a
-- `strava:backfill-rides` re-run silently reverted those corrections.
--
-- `corrected_fields` lists the rides columns the athlete has corrected by
-- hand; upsertRide keeps the stored value for each one instead of taking the
-- source's. Same "human beats machine" rule as lib/sync/mergeField.ts, scoped
-- to the few ingest-owned columns — rides are not a replicated sync table.
-- Written via services/activityCorrections.ts correctRide().
--
-- EXPAND phase only (migrations/README.md): one new column with a safe
-- default. Nothing corrected yet → '{}'.
ALTER TABLE public.rides
  ADD COLUMN corrected_fields TEXT[] NOT NULL DEFAULT '{}';

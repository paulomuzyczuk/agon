-- Fitbit-wrist-derived cadence (2026-09-05) — an independent SECOND opinion on
-- run-stop detection, alongside the existing phone-accelerometer cadence
-- already stored in `cadence` (see lib/movingTime.ts::deriveMovingFlagsFromCadence).
-- The phone-cadence cross-check found 91.8% agreement with the GPS-speed method
-- but a lower confirmed-stop recall (130 vs ~221), with the leading hypothesis
-- being phone-signal noise (the athlete carries the phone, not a wrist sensor)
-- rather than a genuine physical difference. A wrist-worn accelerometer (the
-- Fitbit Air, already the primary HR source — services/googleHealth/heartRate.ts)
-- is far more tightly coupled to arm swing than a pocketed/handheld phone, so
-- this is a genuinely independent second signal to compare against both.
--
-- Stored SEPARATELY from `cadence` (the phone/GPX method) — never overwriting
-- it — same "keep both, compare" discipline as `derived_moving` vs `moving`.
-- Resampled onto the SAME time_s axis as the row it's attached to (a
-- distance-bearing 'strava'/'strava_export' row today — see
-- docs/methodology-log.md, 2026-09-05 "Fitbit-wrist cadence" entry, for why
-- Google Health's own `steps` dataType is native to 1-minute buckets, coarser
-- than this row's per-sample time axis, and for the resampling approach).
--
-- EXPAND phase only (migrations/README.md): a nullable column on an existing
-- table, nothing destroyed.
ALTER TABLE public.run_streams ADD COLUMN fitbit_cadence INT[];

COMMENT ON COLUMN public.run_streams.fitbit_cadence IS
  'Fitbit-wrist steps/min, resampled from Google Health''s steps dataType (1-minute native buckets) onto this row''s time_s axis. Independent second opinion vs. the phone-derived `cadence` column and vs. `moving`/`derived_moving`. NULL per-sample where the wrist device had no bucket covering that instant (device off-wrist, sync gap, or MobileTrack-only coverage) — see scripts/backfill-fitbit-cadence.ts for the per-run coverage gate.';

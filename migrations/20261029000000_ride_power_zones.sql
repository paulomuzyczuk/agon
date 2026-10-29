-- Time in power zones per ride (MZY-63): seconds spent in each of the seven
-- Coggan zones (Z1 active recovery ... Z7 neuromuscular), derived by
-- lib/powerZones.ts from the same DEVICE watts stream NP is computed from.
--
-- zone_seconds[1..7] = seconds in Zone 1..7 over the ride's active timeline, so
-- the array sums to duration_s. Like IF and TSS it exists only together with the
-- FTP it was computed from (ftp_w); no FTP, no zones. Estimated and hand-logged
-- watts never reach this table (the loader gate in services/ridePowerMetrics.ts).
--
-- EXPAND phase only: one nullable column on a derived table, nothing destroyed.
-- Existing rows keep NULL until `pnpm power:backfill-metrics --write` recomputes
-- them.
ALTER TABLE public.ride_power_metrics
  ADD COLUMN IF NOT EXISTS zone_seconds INT[];

ALTER TABLE public.ride_power_metrics
  ADD CONSTRAINT ride_power_metrics_zone_seconds_shape CHECK (
    zone_seconds IS NULL
    OR (array_length(zone_seconds, 1) = 7 AND 0 <= ALL (zone_seconds))
  ),
  ADD CONSTRAINT ride_power_metrics_zones_need_ftp CHECK (
    (zone_seconds IS NULL) OR (ftp_w IS NOT NULL)
  );

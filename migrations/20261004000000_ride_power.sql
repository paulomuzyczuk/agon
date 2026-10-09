-- Ride power, stored with its provenance (MZY-267). No ride table held watts
-- yet. The athlete has no power meter (the Merida Silex 400 has none), so
-- today the only watts on offer are Strava's own ESTIMATE (summary
-- `device_watts=false`). That distinction is the core constraint: every watt
-- carries where it came from, and only device-measured power may feed NP /
-- IF / TSS, FTP and power curves (derived later, see .claude/rules/
-- premium-parity.md). Estimated and hand-logged watts are kept for display,
-- labelled as such, never computed on.
--
-- rides:
--   avg_power_w / max_power_w  — summary watts as the source reported them.
--   weighted_avg_power_w       — the SOURCE's NP-like figure (Strava
--                                `weighted_average_watts`, meter rides only).
--                                Agon's own computed NP lives in a separate
--                                derived table, never in this column.
--   kilojoules                 — mechanical work (Strava `kilojoules`).
--   power_source               — 'device' (a power meter measured it),
--                                'estimated' (the source modelled it),
--                                'manual' (pnpm ride:add); NULL = no power.
-- ride_streams:
--   watts / watts_source       — index-aligned with time_s (same shape as
--                                cadence). Provenance is per STREAM ROW, not
--                                per ride: one ride can hold a Strava
--                                estimated series next to a live-recorded
--                                measured one.
--
-- All five rides columns are source-owned (services/activityCorrections.ts
-- SOURCE_OWNED_RIDE_COLUMNS), so a hand correction survives re-ingest.
--
-- Grants: none needed. dbt_writer's SELECT on rides/ride_streams is
-- table-level (20260910010000/20260910020000) and mcp_reader holds SELECT ON
-- ALL TABLES (20260730000000) — both cover new columns automatically.
--
-- EXPAND phase only (migrations/README.md): nullable columns, nothing
-- destroyed, every existing row satisfies the CHECKs (all NULL).
ALTER TABLE public.rides
  ADD COLUMN avg_power_w          INT CHECK (avg_power_w BETWEEN 0 AND 3000),
  ADD COLUMN max_power_w          INT CHECK (max_power_w BETWEEN 0 AND 3000),
  ADD COLUMN weighted_avg_power_w INT CHECK (weighted_avg_power_w BETWEEN 0 AND 3000),
  ADD COLUMN kilojoules           NUMERIC(8,1) CHECK (kilojoules >= 0),
  ADD COLUMN power_source         TEXT CHECK (power_source IN ('device', 'estimated', 'manual')),
  ADD CONSTRAINT rides_power_has_source CHECK (
    power_source IS NOT NULL
    OR (avg_power_w IS NULL AND max_power_w IS NULL
        AND weighted_avg_power_w IS NULL AND kilojoules IS NULL)
  );

ALTER TABLE public.ride_streams
  ADD COLUMN watts        INT[],
  ADD COLUMN watts_source TEXT CHECK (watts_source IN ('device', 'estimated')),
  ADD CONSTRAINT ride_streams_watts_has_source CHECK (
    watts IS NULL OR watts_source IS NOT NULL
  );

COMMENT ON COLUMN public.rides.power_source IS
  'Provenance of the power columns: device (measured), estimated (source model), manual (hand-logged); NULL = no power. Only device power feeds NP/IF/TSS/curves.';
COMMENT ON COLUMN public.ride_streams.watts_source IS
  'Provenance of this row''s watts series: device (measured) or estimated (source model).';

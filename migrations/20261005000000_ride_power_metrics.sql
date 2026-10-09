-- Agon-computed ride power metrics (MZY-269): Normalized Power, Intensity
-- Factor, Training Stress Score and a mean-maximal power curve, derived by
-- lib/power.ts (Allen & Coggan formulas) from ride_streams.watts.
--
-- PROVENANCE: computed ONLY from a stream row with watts_source = 'device'
-- (a power meter measured it). Estimated (Strava's model) and hand-logged
-- watts never reach these tables — the gate is the loader query in
-- services/ridePowerMetrics.ts. A ride without a device stream has no row.
-- These are separate from rides.weighted_avg_power_w, which is the SOURCE's
-- own NP-like figure (migrations/20261004000000_ride_power.sql).
--
-- TSS NEVER ENTERS TRAINING LOAD (.claude/rules/premium-parity.md #8):
-- training_load_daily stays the Relative Effort (TRIMP) sum over runs and
-- rides. Nothing here is read by services/trainingLoad.ts.
--
-- ride_power_metrics: one row per ride (ride_id PK, recompute overwrites).
--   ftp_w records the FTP the IF/TSS were computed with (from the athlete
--   profile's ftpHistory, MZY-269) — the same anchor-provenance idea as
--   ride_relative_effort.hr_rest/hr_max. NULL ftp_w ⇒ NULL IF and TSS.
--   duration_s / avg / max / kilojoules are over the ACTIVE timeline of the
--   device stream (pauses over 5 s removed — lib/power.ts MAX_HOLD_GAP_S).
-- ride_power_curve: one row per (ride, duration) — the best average watts
--   for each standard duration (lib/power.ts POWER_CURVE_DURATIONS_S) the
--   ride is long enough for. Rows, not arrays, so a season-best curve is a
--   plain GROUP BY duration_s max(watts) in dbt/Lightdash.
--
-- Written by services/ridePowerMetrics.ts — `pnpm power:backfill-metrics`
-- and the 'power_metrics' step of services/activityDerived.ts.
--
-- EXPAND phase only: two fresh derived tables, nothing destroyed.
CREATE TABLE public.ride_power_metrics (
  ride_id          UUID PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  stream_source    TEXT NOT NULL,  -- ride_streams.source of the device series used
  ftp_w            INT CHECK (ftp_w BETWEEN 50 AND 1000),
  np_w             INT NOT NULL CHECK (np_w BETWEEN 0 AND 3000),
  intensity_factor NUMERIC(4,3) CHECK (intensity_factor >= 0),
  tss              NUMERIC(6,1) CHECK (tss >= 0),
  duration_s       INT NOT NULL CHECK (duration_s > 0),
  avg_power_w      INT NOT NULL CHECK (avg_power_w BETWEEN 0 AND 3000),
  max_power_w      INT NOT NULL CHECK (max_power_w BETWEEN 0 AND 3000),
  kilojoules       NUMERIC(8,1) NOT NULL CHECK (kilojoules >= 0),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- IF and TSS exist together, and only with the FTP they were computed from.
  CONSTRAINT ride_power_metrics_ftp_anchored CHECK (
    (ftp_w IS NULL AND intensity_factor IS NULL AND tss IS NULL)
    OR (ftp_w IS NOT NULL AND intensity_factor IS NOT NULL AND tss IS NOT NULL)
  )
);

CREATE TRIGGER trg_ride_power_metrics_touch BEFORE UPDATE ON public.ride_power_metrics
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.ride_power_curve (
  ride_id    UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  duration_s INT NOT NULL CHECK (duration_s > 0),
  watts      INT NOT NULL CHECK (watts BETWEEN 0 AND 3000),
  PRIMARY KEY (ride_id, duration_s)
);

COMMENT ON TABLE public.ride_power_metrics IS
  'Per-ride NP/IF/TSS from DEVICE-measured watts only (lib/power.ts, Allen & Coggan). ftp_w = FTP used. Never feeds training load.';
COMMENT ON TABLE public.ride_power_curve IS
  'Per-ride mean-maximal power (best avg W per duration), DEVICE-measured watts only. One row per (ride, duration).';

-- Whitelisted raw sources for dbt (per 20260723001000_analytics_roles.sql).
-- mcp_reader already holds SELECT ON ALL TABLES (20260730000000).
GRANT SELECT ON public.ride_power_metrics TO dbt_writer;
GRANT SELECT ON public.ride_power_curve TO dbt_writer;

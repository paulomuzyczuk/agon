-- Race-time predictions (Premium-Parity #2) — predicted times for
-- 1k/5k/10k/half/marathon (+ a 70k extrapolation) from the athlete's own
-- best-effort pairs (public.strava_best_efforts). Strava has no such feature at
-- all (docs/strava-benchmark.md), so this is net-new, not a parity match.
--
-- Two models, computed by the pure lib/racePrediction.ts and written here by
-- scripts/backfill-race-predictions.ts:
--   * Riegel power law T=a·D^k, with k RECALIBRATED from the athlete's efforts
--     (the transparency win) — plus the generic-k=1.06 baseline for comparison.
--   * Daniels VDOT equivalent, cross-checking Riegel + the measured VO2max.
-- The fit provenance (k, a, R², reference VDOT effort) is denormalized onto each
-- row so the mart is flat + self-describing for Lightdash.
--
-- One row per target distance (PK). Credit GoldenCheetah (GPL-3.0) + Daniels'
-- Running Formula — formulas only, no code (CREDITS.md #1, #9).
--
-- EXPAND phase only (migrations/README.md): a fresh derived table.
CREATE TABLE public.race_predictions (
  label             TEXT PRIMARY KEY,           -- '1K', '5K', '10K', 'Half-Marathon', 'Marathon', '70K'
  distance_m        INT NOT NULL CHECK (distance_m > 0),
  predicted_s       INT NOT NULL CHECK (predicted_s > 0),  -- headline = self-calibrated Riegel
  riegel_self_s     INT NOT NULL,               -- Riegel with the fitted exponent
  riegel_generic_s  INT,                        -- Riegel with generic k=1.06 from the reference effort
  vdot_s            INT,                         -- Daniels VDOT equivalent time
  low_s             INT NOT NULL,               -- prediction band (widens for extrapolation)
  high_s            INT NOT NULL,
  band_pct          NUMERIC(5,3) NOT NULL,      -- band half-width as a fraction of predicted
  extrapolated      BOOLEAN NOT NULL,           -- target longer than every best effort

  -- Fit provenance (shared across rows; denormalized for a flat mart).
  fit_k             NUMERIC(6,4) NOT NULL,      -- fitted Riegel exponent (generic 1.06 if fallback)
  fit_a             DOUBLE PRECISION NOT NULL,  -- multiplier a in T=a·D^k
  fit_r2            NUMERIC(6,4) NOT NULL,      -- log-log fit R²
  fit_fallback      BOOLEAN NOT NULL,           -- true = too few pairs, generic k used
  n_pairs           INT NOT NULL,               -- best-effort pairs the fit used
  ref_vdot          NUMERIC(5,2),               -- reference VDOT
  ref_distance_m    INT,                        -- effort the reference VDOT came from
  ref_time_s        INT,

  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_race_predictions_touch BEFORE UPDATE ON public.race_predictions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.race_predictions IS
  'Predicted race times (Riegel self-calibrated + Daniels VDOT) from best-effort pairs. Derived by lib/racePrediction.ts; surfaced by analytics.fct_race_predictions. Net-new (Strava has no equivalent).';

-- Whitelisted raw source for dbt (mirrors 20260723001000_analytics_roles.sql).
GRANT SELECT ON public.race_predictions TO dbt_writer;

-- Daily training load (CTL / ATL / TSB) — Agon's reimplementation of Strava's
-- paywalled "Fitness & Freshness" and the TrainingPeaks Performance Management
-- Chart, on the Banister impulse-response model (Premium-Parity; CLAUDE.md
-- Dashboard Metrics "Training load"). Credit GoldenCheetah/sweatpy — formulas
-- only, no code (CREDITS.md #1).
--
-- Daily load = SUM of per-run Relative Effort (public.run_relative_effort) for
-- the day. Over a CONTINUOUS date spine (rest days = 0), lib/trainingLoad.ts
-- rolls three EWMAs forward: CTL (42-day, Fitness), ATL (7-day, Fatigue), and
-- TSB = CTL − ATL (Form). Written here by scripts/backfill-training-load.ts and
-- surfaced by analytics.fct_training_load_daily.
--
-- One row per calendar day (date PK → recompute overwrites). Stores the model
-- parameters used so the numbers stay transparent + auditable.
--
-- EXPAND phase only (migrations/README.md): a fresh derived table, nothing
-- destroyed.
CREATE TABLE public.training_load_daily (
  date          DATE PRIMARY KEY,
  daily_load    NUMERIC(8,1) NOT NULL CHECK (daily_load >= 0),  -- Σ Relative Effort that day (0 = rest)
  ctl           NUMERIC(8,1) NOT NULL,   -- Fitness (chronic load), 42-day EWMA
  atl           NUMERIC(8,1) NOT NULL,   -- Fatigue (acute load), 7-day EWMA
  tsb           NUMERIC(8,1) NOT NULL,   -- Form = CTL − ATL (prev-day convention)
  ctl_days      INT NOT NULL,            -- CTL time constant (42)
  atl_days      INT NOT NULL,            -- ATL time constant (7)
  tsb_mode      TEXT NOT NULL CHECK (tsb_mode IN ('prev-day', 'same-day')),
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_training_load_daily_touch BEFORE UPDATE ON public.training_load_daily
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.training_load_daily IS
  'Daily Banister CTL/ATL/TSB from the per-run Relative Effort sum. Derived by lib/trainingLoad.ts; surfaced by analytics.fct_training_load_daily.';

-- Whitelisted raw source for dbt (mirrors 20260723001000_analytics_roles.sql —
-- a new raw source table is a deliberate GRANT, never automatic).
GRANT SELECT ON public.training_load_daily TO dbt_writer;

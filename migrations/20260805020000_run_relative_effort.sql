-- Relative Effort (per-activity training-load score, Premium-Parity #7). Agon's
-- reimplementation of Strava's paywalled Relative Effort as Banister TRIMP,
-- computed from the HR series in run_streams (or avg HR as a fallback) by the pure
-- lib/relativeEffort.ts and written here by scripts/backfill-relative-effort.ts.
--
-- One score per run (run_id PK → recompute overwrites). Stores the inputs it used
-- so the number is transparent + auditable (which method, which HR stream, the HR
-- anchors). Its daily sum is the training-load input to the future
-- fct_training_load_daily (CTL/ATL/TSB) mart.
--
-- EXPAND phase only: a fresh derived table, nothing destroyed.
CREATE TABLE public.run_relative_effort (
  run_id        UUID PRIMARY KEY REFERENCES public.runs(id) ON DELETE CASCADE,
  score         NUMERIC(7,1) NOT NULL CHECK (score >= 0),  -- TRIMP units
  method        TEXT NOT NULL CHECK (method IN ('stream', 'average')),
  stream_source TEXT,   -- run_streams.source integrated (NULL for the 'average' method)
  hr_rest       INT NOT NULL,  -- HR anchors used (from the athlete profile)
  hr_max        INT NOT NULL,
  duration_s    INT,    -- session duration used (average method / reference)
  avg_hr        INT,    -- avg HR used (average method)
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_run_relative_effort_touch BEFORE UPDATE ON public.run_relative_effort
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.run_relative_effort IS
  'Per-run Relative Effort (Banister TRIMP). Derived by lib/relativeEffort.ts; surfaced by analytics.fct_relative_effort. Daily sum feeds fct_training_load_daily.';

-- Whitelisted raw source for dbt (per 20260723001000_analytics_roles.sql). runs is
-- already granted there for the mart's date/block/week join.
GRANT SELECT ON public.run_relative_effort TO dbt_writer;

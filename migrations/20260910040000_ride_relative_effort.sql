-- Relative Effort for bike rides — sibling to run_relative_effort
-- (migrations/20260805020000_run_relative_effort.sql), not a polymorphic
-- "activity_relative_effort" table, following this session's established
-- precedent (rides vs. runs, lifting vs. runs are all separate tables). The
-- Banister TRIMP math in lib/relativeEffort.ts is stream-generic (HR +
-- getAthleteProfile() anchors, no run-specific coupling), so
-- relativeEffortFromStream/relativeEffortFromAverage are reused as-is against
-- ride_streams/rides. No 'estimated_pace' tier here: that fallback relies on
-- a pace→HR fit calibrated on RUNNING pace (lib/relativeEffort.ts
-- fitPaceHrModel), which doesn't transfer to cycling speed — a HR-less ride
-- is simply left unscored (v1; CLAUDE.md backlog can revisit a cycling
-- power/speed→HR model later).
--
-- One score per ride (ride_id PK → recompute overwrites), computed by
-- scripts/backfill-relative-effort-rides.ts. Its daily sum, UNIONed with
-- run_relative_effort's, feeds public.training_load_daily (services/
-- trainingLoad.ts loadDailyRelativeEffort).
--
-- EXPAND phase only: a fresh derived table, nothing destroyed.
CREATE TABLE public.ride_relative_effort (
  ride_id       UUID PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE,
  score         NUMERIC(7,1) NOT NULL CHECK (score >= 0),  -- TRIMP units
  method        TEXT NOT NULL CHECK (method IN ('stream', 'average')),
  stream_source TEXT,   -- ride_streams.source integrated (NULL for the 'average' method)
  hr_rest       INT NOT NULL,  -- HR anchors used (from the athlete profile)
  hr_max        INT NOT NULL,
  duration_s    INT,    -- session duration used (average method / reference)
  avg_hr        INT,    -- avg HR used (average method)
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_ride_relative_effort_touch BEFORE UPDATE ON public.ride_relative_effort
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.ride_relative_effort IS
  'Per-ride Relative Effort (Banister TRIMP), sibling to run_relative_effort. Derived by lib/relativeEffort.ts; surfaced by analytics.fct_ride_relative_effort. Daily sum (UNIONed with run_relative_effort) feeds fct_training_load_daily.';

-- Whitelisted raw source for dbt (per 20260723001000_analytics_roles.sql). rides
-- is already granted there for the mart's date/block/week join.
GRANT SELECT ON public.ride_relative_effort TO dbt_writer;

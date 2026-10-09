-- Widen run_relative_effort.method to admit 'estimated_pace' — the last-resort
-- tier for runs with NO heart rate at all (no stream, no average, not even a
-- manual estimate). Their Relative Effort is computed from an HR estimated off
-- the run's pace via the athlete's own pace→HR fit (lib/relativeEffort.ts
-- fitPaceHrModel / relativeEffortFromPace), so a HR-less run contributes a
-- realistic load instead of a silent 0 (the June-2026 zero-load artifact).
--
-- The method label keeps the fidelity tier transparent + auditable:
--   'stream'         HR series integrated (best)
--   'average'        single average HR (measured or manually estimated)
--   'estimated_pace' HR inferred from pace (lowest fidelity)
--
-- EXPAND phase only: relax an enum CHECK, nothing destroyed. Existing rows
-- (all 'stream'/'average') still satisfy the wider constraint.
ALTER TABLE public.run_relative_effort
  DROP CONSTRAINT run_relative_effort_method_check;

ALTER TABLE public.run_relative_effort
  ADD CONSTRAINT run_relative_effort_method_check
  CHECK (method IN ('stream', 'average', 'estimated_pace'));

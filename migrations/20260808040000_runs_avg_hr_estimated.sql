-- First-class provenance for runs.avg_hr: was this average MEASURED (chest strap /
-- HR stream) or MANUALLY ESTIMATED by the athlete (a chest-strap-less run whose
-- avg HR was filled by scripts/import-manual-hr.ts)? Until now the two were only
-- separable via the general_notes text stamp; this makes it a queryable column so
-- analytics/marts can weight or exclude estimated averages explicitly.
--
-- 'estimated' here means the avg_hr VALUE is an athlete estimate. It is distinct
-- from run_relative_effort.method='estimated_pace' (which is HR inferred from pace
-- for runs with NO avg_hr at all — those keep avg_hr NULL, so avg_hr_estimated
-- stays false / irrelevant for them).
--
-- EXPAND phase only: a new nullable-with-default column, nothing destroyed.
-- Measured averages take the default (false).
ALTER TABLE public.runs
  ADD COLUMN avg_hr_estimated BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.runs.avg_hr_estimated IS
  'True when avg_hr is a manual athlete estimate (chest-strap-less run, filled by scripts/import-manual-hr.ts), not a measured average.';

-- Back-populate the rows already imported by scripts/import-manual-hr.ts, keyed on
-- the provenance note it stamps (idempotent — matches only those rows).
UPDATE public.runs
   SET avg_hr_estimated = true
 WHERE avg_hr IS NOT NULL
   AND general_notes LIKE 'avg_hr estimated by athlete%';

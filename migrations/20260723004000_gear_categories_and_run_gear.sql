-- Generalize gear beyond shoes: add a category, and move from the single
-- runs.gear_id (one shoe) to a run_gear join so a run can carry several items
-- across categories (shoe + HRM + watch + ...). EXPAND half of an
-- expand/contract pair — runs.gear_id is dropped in the next migration once its
-- data has been copied here.

-- 1. Category on gear. Existing rows are all Strava shoes → default 'shoe' to
--    backfill them, then drop the default so future inserts are explicit.
ALTER TABLE public.gear
  ADD COLUMN category TEXT NOT NULL DEFAULT 'shoe'
    CHECK (category IN ('shoe', 'hrm', 'watch', 'wristband', 'other'));
ALTER TABLE public.gear ALTER COLUMN category DROP DEFAULT;

-- 2. The run <-> gear join (many-to-many).
CREATE TABLE public.run_gear (
  run_id     UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  gear_id    TEXT NOT NULL REFERENCES public.gear(gear_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, gear_id)
);
CREATE INDEX idx_run_gear_gear ON public.run_gear (gear_id);

-- 3. Copy the existing single-shoe links into the join (no-op on empty tables).
INSERT INTO public.run_gear (run_id, gear_id)
SELECT id, gear_id FROM public.runs WHERE gear_id IS NOT NULL
ON CONFLICT DO NOTHING;

GRANT SELECT ON public.run_gear TO dbt_writer;

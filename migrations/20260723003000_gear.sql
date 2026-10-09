-- Gear (shoe) catalog + per-run link. Gives every physical shoe ONE stable
-- gear_id so per-shoe mileage aggregates across sources:
--   * Strava-known shoes use Strava's own gear id (e.g. 'g10758916') and name.
--   * shoes Strava has no id for (a run logged by voice note, gear tracking off)
--     get a locally-minted, deterministic id: 'local:<slug-of-name>' — same name
--     always yields the same id, so one shoe never fans out into duplicates.
-- The unique index on lower(name) encodes the "one row per shoe" invariant.
--
-- runs.shoe_used stays as the denormalized name (mirrors the fueling pattern:
-- raw capture alongside the normalized link); runs.gear_id is the FK analytics
-- groups by.

CREATE TABLE public.gear (
  gear_id     TEXT PRIMARY KEY,   -- Strava gear id, or 'local:<slug>'
  name        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('strava', 'local')),
  brand       TEXT,
  retired     BOOLEAN NOT NULL DEFAULT FALSE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_gear_name_ci ON public.gear (lower(name));
CREATE TRIGGER trg_gear_touch BEFORE UPDATE ON public.gear
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.runs
  ADD COLUMN gear_id TEXT REFERENCES public.gear(gear_id) ON DELETE SET NULL;
CREATE INDEX idx_runs_gear ON public.runs (gear_id);

GRANT SELECT ON public.gear TO dbt_writer;

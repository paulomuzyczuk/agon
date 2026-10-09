-- General health tracking (decision 2026-08-24, follow-on to the nutrition
-- feature). Extends Agon beyond sports/nutrition into the other life domains
-- CLAUDE.md's Build Order names for later integration: test results,
-- skincare/teeth routines, plus medications, injuries, medical visits,
-- vaccinations, and allergies/chronic conditions surfaced during scoping.
-- (Vision explicitly excluded per athlete direction.) Same conventions as
-- core_schema.sql: UUID PKs, touch_updated_at for mutable header rows, TEXT +
-- CHECK for small closed vocabularies, open TEXT where the vocabulary is
-- inherently unbounded (test markers, body parts, vaccine names — mirrors
-- nutrition_goals.goal_key being open text for the same reason).
--
-- Six concerns, each its own table group:
--   1. lab_panels / lab_panel_results — any test event (blood panel,
--      spermogram, hormone panel, urinalysis, ...) as a header row + one row
--      per marker. Markers are open text with optional numeric AND/OR text
--      value (some results are qualitative, e.g. blood type, morphology
--      grade) plus an optional reference range for at-a-glance flagging.
--   2. routines / routine_steps / routine_logs — skincare + dental care
--      habit tracking. Mirrors meal_templates/meal_logs: a reusable routine
--      definition (its steps) + daily adherence log.
--   3. medications / medication_logs — a general medication + supplement
--      ledger (beyond the training-program-specific creatine goal already in
--      nutrition_goals / nutrition_days.creatine_taken).
--   4. injuries / injury_updates — non-running-specific injury/pain tracking
--      (runs already have pain_location/pain_onset_km for in-run pain; this
--      is the standalone tracker with a status timeline).
--   5. medical_visits — doctor/dentist/specialist appointments, findings,
--      follow-ups. One row per visit; dental checkups are just a visit_type.
--   6. vaccinations — append-mostly immunization record.
--   7. health_conditions — allergies + chronic conditions as a small
--      reference table, mainly consulting-layer context (so Claude knows
--      constraints when giving advice), not a time series.
--
-- As with nutrition_goals, no numeric reference values are hardcoded in code;
-- reference ranges live per-result (lab reports print their own ranges) and
-- everything else is athlete-entered data, not seeded config.

-- ── 1. lab / test results ──────────────────────────────────────────────────
CREATE TABLE public.lab_panels (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL,
  panel_type  TEXT NOT NULL,   -- open text: 'blood_general' / 'spermogram' / 'hormone_panel' / 'urinalysis' / ...
  lab_name    TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lab_panels_date ON public.lab_panels (date);
CREATE TRIGGER trg_lab_panels_touch BEFORE UPDATE ON public.lab_panels
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.lab_panel_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lab_panel_id    UUID NOT NULL REFERENCES public.lab_panels(id) ON DELETE CASCADE,
  marker          TEXT NOT NULL,   -- open text: 'hemoglobin' / 'testosterone' / 'sperm_concentration' / 'blood_type' / ...
  value_numeric   NUMERIC(14,4),
  value_text      TEXT,            -- for qualitative results (e.g. 'O+', 'normal morphology')
  unit            TEXT,
  reference_low   NUMERIC(14,4),
  reference_high  NUMERIC(14,4),
  flag            TEXT CHECK (flag IN ('low','normal','high','abnormal')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lab_panel_results_has_value CHECK (value_numeric IS NOT NULL OR value_text IS NOT NULL)
);
CREATE INDEX idx_lab_panel_results_panel ON public.lab_panel_results (lab_panel_id);
CREATE INDEX idx_lab_panel_results_marker ON public.lab_panel_results (marker);

-- ── 2. skincare / dental routines ────────────────────────────────────────────
CREATE TABLE public.routines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  routine_type  TEXT NOT NULL CHECK (routine_type IN ('skincare','dental')),
  time_of_day   TEXT CHECK (time_of_day IN ('am','pm','any')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_routines_touch BEFORE UPDATE ON public.routines
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.routine_steps (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id  UUID NOT NULL REFERENCES public.routines(id) ON DELETE CASCADE,
  step_order  INT NOT NULL DEFAULT 0,
  product     TEXT NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_routine_steps_routine ON public.routine_steps (routine_id);

CREATE TABLE public.routine_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL,
  routine_id  UUID NOT NULL REFERENCES public.routines(id) ON DELETE RESTRICT,
  completed   BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,             -- e.g. skin condition / irritation notes
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, routine_id)
);
CREATE INDEX idx_routine_logs_date ON public.routine_logs (date);

-- ── 3. medications & supplements ─────────────────────────────────────────────
CREATE TABLE public.medications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL CHECK (kind IN ('medication','supplement')),
  dosage      TEXT,             -- free text, e.g. '500 mg', '1 tablet'
  schedule    TEXT,             -- free text, e.g. 'daily', 'as needed'
  active      BOOLEAN NOT NULL DEFAULT true,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_medications_touch BEFORE UPDATE ON public.medications
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.medication_logs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  medication_id  UUID NOT NULL REFERENCES public.medications(id) ON DELETE RESTRICT,
  date           DATE NOT NULL,
  taken_at       TIMESTAMPTZ,
  quantity       NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_medication_logs_date ON public.medication_logs (date);
CREATE INDEX idx_medication_logs_medication ON public.medication_logs (medication_id);

-- ── 4. injuries ───────────────────────────────────────────────────────────────
CREATE TABLE public.injuries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onset_date     DATE NOT NULL,
  body_part      TEXT NOT NULL,
  description    TEXT,
  severity       INT CHECK (severity BETWEEN 1 AND 10),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','improving','resolved')),
  resolved_date  DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_injuries_status ON public.injuries (status);
CREATE TRIGGER trg_injuries_touch BEFORE UPDATE ON public.injuries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.injury_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  injury_id   UUID NOT NULL REFERENCES public.injuries(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  severity    INT CHECK (severity BETWEEN 1 AND 10),
  status      TEXT CHECK (status IN ('active','improving','resolved')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_injury_updates_injury ON public.injury_updates (injury_id);

-- ── 5. medical / dental visits ───────────────────────────────────────────────
CREATE TABLE public.medical_visits (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date             DATE NOT NULL,
  visit_type       TEXT NOT NULL,  -- open text: 'general_checkup' / 'dental_cleaning' / 'dermatologist' / ...
  provider         TEXT,
  reason           TEXT,
  findings         TEXT,
  follow_up_date   DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_medical_visits_date ON public.medical_visits (date);
CREATE TRIGGER trg_medical_visits_touch BEFORE UPDATE ON public.medical_visits
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── 6. vaccinations ───────────────────────────────────────────────────────────
CREATE TABLE public.vaccinations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vaccine        TEXT NOT NULL,
  date           DATE NOT NULL,
  dose_number    INT,
  provider       TEXT,
  next_due_date  DATE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vaccinations_date ON public.vaccinations (date);

-- ── 7. allergies & chronic conditions ────────────────────────────────────────
CREATE TABLE public.health_conditions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_type   TEXT NOT NULL CHECK (condition_type IN ('allergy','chronic_condition','other')),
  name             TEXT NOT NULL,
  severity         TEXT,   -- free text, e.g. 'mild' / 'severe' / 'anaphylaxis'
  diagnosed_date   DATE,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','managed')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (condition_type, name)
);
CREATE TRIGGER trg_health_conditions_touch BEFORE UPDATE ON public.health_conditions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── analytics access (mcp_reader already covers all tables via the default
--    privilege in 20260730000000_mcp_reader_role.sql; dbt_writer granted here
--    for future marts, same as nutrition) ──────────────────────────────────────
GRANT SELECT ON public.lab_panels          TO dbt_writer;
GRANT SELECT ON public.lab_panel_results   TO dbt_writer;
GRANT SELECT ON public.routines            TO dbt_writer;
GRANT SELECT ON public.routine_steps       TO dbt_writer;
GRANT SELECT ON public.routine_logs        TO dbt_writer;
GRANT SELECT ON public.medications         TO dbt_writer;
GRANT SELECT ON public.medication_logs     TO dbt_writer;
GRANT SELECT ON public.injuries            TO dbt_writer;
GRANT SELECT ON public.injury_updates      TO dbt_writer;
GRANT SELECT ON public.medical_visits      TO dbt_writer;
GRANT SELECT ON public.vaccinations        TO dbt_writer;
GRANT SELECT ON public.health_conditions   TO dbt_writer;

COMMENT ON TABLE public.lab_panels IS
  'Any test event (blood panel, spermogram, hormone panel, urinalysis, ...). panel_type is open text by design.';
COMMENT ON TABLE public.lab_panel_results IS
  'One row per marker per panel. marker is open text; value_numeric and/or value_text so qualitative results (blood type, morphology grade) are representable.';
COMMENT ON TABLE public.routines IS
  'Skincare / dental routine definitions (their steps). routine_logs tracks daily adherence.';
COMMENT ON TABLE public.medications IS
  'General medication + supplement ledger, separate from the training-program creatine goal already in nutrition_goals.';
COMMENT ON TABLE public.injuries IS
  'Standalone injury/pain tracker (distinct from runs.pain_location, which is in-run-only). injury_updates is its status timeline.';
COMMENT ON TABLE public.health_conditions IS
  'Allergies + chronic conditions — a small reference table, mainly consulting-layer context. condition_type+name unique.';

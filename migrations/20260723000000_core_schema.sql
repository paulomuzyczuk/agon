-- Agon core schema (data backbone milestone). Maps 1:1 to the "Database Schema"
-- section of CLAUDE.md. Single-user platform: no auth.users FK, no RLS,
-- no tenant column — access control is the single owner login + network.
--
-- Conventions:
--   * uuid PKs via gen_random_uuid() (built into Postgres 13+, no extension).
--   * created_at / updated_at on mutable tables; updated_at maintained by the
--     shared touch_updated_at() trigger below.
--   * controlled vocabularies are TEXT + CHECK (expand/contract-friendly —
--     evolving a CHECK is a migration, not an ALTER TYPE dance).
--   * `block` / `week` are the program coordinates derived at ingest by
--     lib/trainingBlocks.ts; nullable for pre-program (baseline) rows.

-- ── shared updated_at trigger ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── runs ──────────────────────────────────────────────────────────────────────
-- One row per run. Qualitative columns (fueling, perceived_effort, pain_*,
-- general_notes) and weather columns are filled by LATER milestones (voice-note
-- pipeline, Open-Meteo enrichment); the Strava backfill leaves them NULL.
CREATE TABLE public.runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date                DATE NOT NULL,
  block               INT,
  week                INT,
  distance_km         NUMERIC(7,3) NOT NULL CHECK (distance_km > 0),
  duration_s          INT NOT NULL CHECK (duration_s > 0),
  avg_hr              INT CHECK (avg_hr BETWEEN 0 AND 260),
  max_hr              INT CHECK (max_hr BETWEEN 0 AND 260),
  avg_pace_s_per_km   NUMERIC(7,2) CHECK (avg_pace_s_per_km > 0),
  elevation_gain_m    NUMERIC(7,1),
  shoe_used           TEXT,
  fueling             TEXT,                 -- raw voice-note capture; structured intake -> run_fueling_items
  perceived_effort    INT CHECK (perceived_effort BETWEEN 1 AND 10),
  pain_location       TEXT,
  pain_onset_km       NUMERIC(6,2) CHECK (pain_onset_km >= 0),
  general_notes       TEXT,
  strava_activity_id  BIGINT UNIQUE,        -- idempotency key for the backfill; NULL for manual runs
  source              TEXT NOT NULL CHECK (source IN ('strava','polar','telegram','manual')),
  -- weather enrichment (Open-Meteo), joined on start time + GPS in a later job:
  temp_c              NUMERIC(4,1),
  humidity_pct        NUMERIC(5,2) CHECK (humidity_pct BETWEEN 0 AND 100),
  wind_kph            NUMERIC(5,1) CHECK (wind_kph >= 0),
  weather_conditions  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_runs_date ON public.runs (date);
CREATE TRIGGER trg_runs_touch BEFORE UPDATE ON public.runs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── lifting (normalized to set-level granularity) ─────────────────────────────
CREATE TABLE public.lifting_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date              DATE NOT NULL,
  block             INT,
  week              INT,
  session_type      TEXT NOT NULL,          -- 'A'/'B'/'C' or 'Push'/'Pull'/'Legs'
  duration_min      INT CHECK (duration_min > 0),
  perceived_effort  INT CHECK (perceived_effort BETWEEN 1 AND 10),
  notes             TEXT,
  source            TEXT NOT NULL DEFAULT 'telegram'
                      CHECK (source IN ('strava','polar','telegram','manual')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lifting_sessions_date ON public.lifting_sessions (date);
CREATE TRIGGER trg_lifting_sessions_touch BEFORE UPDATE ON public.lifting_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.lifting_exercises (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES public.lifting_sessions(id) ON DELETE CASCADE,
  exercise        TEXT NOT NULL,
  exercise_order  INT NOT NULL CHECK (exercise_order >= 0),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, exercise_order)
);
CREATE INDEX idx_lifting_exercises_session ON public.lifting_exercises (session_id);

CREATE TABLE public.lifting_sets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exercise_id UUID NOT NULL REFERENCES public.lifting_exercises(id) ON DELETE CASCADE,
  set_number  INT NOT NULL CHECK (set_number >= 1),
  reps        INT CHECK (reps >= 0),
  weight_kg   NUMERIC(6,2) CHECK (weight_kg >= 0),
  rpe         NUMERIC(3,1) CHECK (rpe BETWEEN 0 AND 10),
  rest_s      INT CHECK (rest_s >= 0),
  is_warmup   BOOLEAN NOT NULL DEFAULT FALSE,
  is_failure  BOOLEAN NOT NULL DEFAULT FALSE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exercise_id, set_number)
);
CREATE INDEX idx_lifting_sets_exercise ON public.lifting_sets (exercise_id);

-- ── fueling catalog + per-run intake ──────────────────────────────────────────
-- Per-serving nutrient facts. Voice-note fueling items resolve against this
-- catalog by name; unmatched products get flagged for a catalog add.
CREATE TABLE public.fueling_products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL
                  CHECK (category IN ('water','isotonic','gel','food','salt_cap','other')),
  serving_desc  TEXT,                        -- e.g. '500 ml bottle', '1 sachet'
  water_ml      NUMERIC(7,1) CHECK (water_ml   >= 0),
  carbs_g       NUMERIC(6,2) CHECK (carbs_g    >= 0),
  sodium_mg     NUMERIC(7,1) CHECK (sodium_mg  >= 0),
  potassium_mg  NUMERIC(7,1) CHECK (potassium_mg >= 0),
  magnesium_mg  NUMERIC(7,1) CHECK (magnesium_mg >= 0),
  caffeine_mg   NUMERIC(6,1) CHECK (caffeine_mg >= 0),
  kcal          NUMERIC(6,1) CHECK (kcal       >= 0),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_fueling_products_touch BEFORE UPDATE ON public.fueling_products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.run_fueling_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES public.fueling_products(id) ON DELETE RESTRICT,
  quantity    NUMERIC(6,3) NOT NULL CHECK (quantity > 0),  -- servings, fractional ok
  timing_km   NUMERIC(6,2) CHECK (timing_km >= 0),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_run_fueling_items_run ON public.run_fueling_items (run_id);
CREATE INDEX idx_run_fueling_items_product ON public.run_fueling_items (product_id);

-- ── planned sessions (program -> calendar + plan-vs-actual) ────────────────────
CREATE TABLE public.planned_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date                DATE NOT NULL,
  block               INT,
  week                INT,
  session_kind        TEXT NOT NULL CHECK (session_kind IN ('run','lift','rest')),
  description         TEXT,
  target_distance_km  NUMERIC(6,2) CHECK (target_distance_km >= 0),
  target_hr_cap       INT CHECK (target_hr_cap BETWEEN 0 AND 260),
  target_session_type TEXT,
  gcal_event_id       TEXT UNIQUE,           -- stored so gcal sync is idempotent
  status              TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','synced','completed','skipped')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_planned_sessions_date ON public.planned_sessions (date);
CREATE TRIGGER trg_planned_sessions_touch BEFORE UPDATE ON public.planned_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── nutrition (one row per day) ───────────────────────────────────────────────
CREATE TABLE public.nutrition_days (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date            DATE NOT NULL UNIQUE,
  block           INT,
  week            INT,
  kcal            NUMERIC(7,1) CHECK (kcal      >= 0),
  protein_g       NUMERIC(6,1) CHECK (protein_g >= 0),
  carbs_g         NUMERIC(6,1) CHECK (carbs_g   >= 0),
  fat_g           NUMERIC(6,1) CHECK (fat_g     >= 0),
  creatine_taken  BOOLEAN,
  alcohol_event   BOOLEAN NOT NULL DEFAULT FALSE,
  source          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_nutrition_days_touch BEFORE UPDATE ON public.nutrition_days
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ── body metrics ──────────────────────────────────────────────────────────────
-- No UNIQUE(date): morning/evening weigh-ins on the same day are allowed.
CREATE TABLE public.body_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date          DATE NOT NULL,
  weight_kg     NUMERIC(5,2) CHECK (weight_kg > 0),
  body_fat_pct  NUMERIC(4,1) CHECK (body_fat_pct BETWEEN 0 AND 100),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_body_metrics_date ON public.body_metrics (date);

-- ── qualitative logs (raw transcript + parsed JSON) ───────────────────────────
CREATE TABLE public.qualitative_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date            DATE NOT NULL,
  session_type    TEXT,                      -- 'run' / 'lift' / ...
  raw_transcript  TEXT,
  parsed_json     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_qualitative_logs_date ON public.qualitative_logs (date);

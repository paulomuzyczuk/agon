-- Nutrition feature (Phase 2 backlog item, decision 2026-08-24). Three concerns:
--
--   1. `foods` — the athlete's own macro catalog, gathered from REWE's website +
--      other online sources (per-item, not the generic BLS/OFF/USDA multi-source
--      resolution still backlogged for `fueling_products`). Each row is "per one
--      serving" exactly like `fueling_products` (serving_qty + serving_unit,
--      not normalized to per-100g) so it matches how the athlete already tracks
--      quantities ("4 eggs", "2 portions of pasta").
--   2. `meal_templates` / `meal_template_items` — the athlete's usual meals
--      (breakfast/lunch/dinner/snack/post-workout groupings), seeded from a
--      personal Google Sheet. Reusable templates so a day's eating can be logged
--      in one shot instead of food-by-food.
--   3. `meal_logs` / `meal_log_items` — actual daily intake, structured at
--      food-level (mirrors `run_fueling_items`): optionally stamped from a
--      template, but always food-level so totals can be summed for "macro
--      counting" against `nutrition_goals`.
--   4. `nutrition_goals` — modular daily targets (water, supplements, and later
--      macros). Deliberately NOT a CHECK-constrained vocabulary like other
--      tables here: goal_key is open text so a new goal (this athlete's or a
--      future user's) is a seed-data change, never a migration. The actual
--      numeric targets are never hardcoded in code — see lib/nutritionGoals.ts
--      + scripts/seed-nutrition-goals.ts for the private-config seed path.

CREATE TABLE public.foods (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  serving_qty   NUMERIC(8,2) NOT NULL CHECK (serving_qty > 0),
  serving_unit  TEXT NOT NULL,               -- 'g' / 'ml' / 'unit' / 'can' / free text, athlete's own units
  carbs_g       NUMERIC(6,2) NOT NULL CHECK (carbs_g   >= 0),
  protein_g     NUMERIC(6,2) NOT NULL CHECK (protein_g >= 0),
  fat_g         NUMERIC(6,2) NOT NULL CHECK (fat_g     >= 0),
  kcal          NUMERIC(7,1) NOT NULL CHECK (kcal      >= 0),
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','rewe')),
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_foods_touch BEFORE UPDATE ON public.foods
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.meal_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  context     TEXT,                          -- free text, e.g. 'office day, breakfast at home'
  block       INT,                           -- training block this plan targets; NULL when block-agnostic
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_meal_templates_touch BEFORE UPDATE ON public.meal_templates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.meal_template_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_template_id  UUID NOT NULL REFERENCES public.meal_templates(id) ON DELETE CASCADE,
  meal_slot         TEXT NOT NULL CHECK (meal_slot IN
                       ('breakfast','lunch','dinner','snack','post_workout','other')),
  item_order        INT NOT NULL DEFAULT 0,
  food_id           UUID NOT NULL REFERENCES public.foods(id) ON DELETE RESTRICT,
  quantity          NUMERIC(6,3) NOT NULL CHECK (quantity > 0),  -- servings, fractional ok
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_meal_template_items_template ON public.meal_template_items (meal_template_id);
CREATE INDEX idx_meal_template_items_food ON public.meal_template_items (food_id);

CREATE TABLE public.meal_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date              DATE NOT NULL,
  meal_slot         TEXT NOT NULL CHECK (meal_slot IN
                       ('breakfast','lunch','dinner','snack','post_workout','other')),
  meal_template_id  UUID REFERENCES public.meal_templates(id) ON DELETE SET NULL,
  source            TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','telegram','template')),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_meal_logs_date ON public.meal_logs (date);

CREATE TABLE public.meal_log_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_log_id  UUID NOT NULL REFERENCES public.meal_logs(id) ON DELETE CASCADE,
  food_id      UUID NOT NULL REFERENCES public.foods(id) ON DELETE RESTRICT,
  quantity     NUMERIC(6,3) NOT NULL CHECK (quantity > 0),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_meal_log_items_log ON public.meal_log_items (meal_log_id);
CREATE INDEX idx_meal_log_items_food ON public.meal_log_items (food_id);

-- ── nutrition goals (modular, per-user; values seeded from private config) ────
CREATE TABLE public.nutrition_goals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_key    TEXT NOT NULL UNIQUE,          -- open vocabulary, e.g. 'water_base_l','vitamin_c_mg'
  value       NUMERIC(10,3) NOT NULL CHECK (value >= 0),
  unit        TEXT NOT NULL,                 -- 'l' / 'mg' / 'iu' / 'g' / 'kcal' / free text
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_nutrition_goals_touch BEFORE UPDATE ON public.nutrition_goals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.foods TO dbt_writer;
GRANT SELECT ON public.meal_templates TO dbt_writer;
GRANT SELECT ON public.meal_template_items TO dbt_writer;
GRANT SELECT ON public.meal_logs TO dbt_writer;
GRANT SELECT ON public.meal_log_items TO dbt_writer;
GRANT SELECT ON public.nutrition_goals TO dbt_writer;

COMMENT ON TABLE public.foods IS
  'Athlete-curated macro catalog (REWE + other online sources) — one row per serving, not per-100g.';
COMMENT ON TABLE public.nutrition_goals IS
  'Modular daily targets. goal_key is open text by design so new goals need no migration; values seeded from a private, gitignored config — see lib/nutritionGoals.ts.';

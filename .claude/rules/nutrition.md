---
paths:
  - "app/nutrition/**"
  - "services/nutritionGoals.ts"
  - "services/mealLogs.ts"
  - "services/foods.ts"
  - "services/mealTemplates.ts"
  - "lib/nutritionGoals.ts"
  - "lib/foodCatalog.ts"
  - "lib/mealTemplates.ts"
  - "components/MealLogForm.tsx"
  - "components/MealLogList.tsx"
  - "migrations/20260824000000_nutrition.sql"
---

# Nutrition — Foods, Usual Meals & Goals

Full build narrative: tracked in Linear ("Nutrition" issues). This file is the
current-state design reference for anyone touching this code.

- **`foods`** — one row per catalog item, **per serving** (`serving_qty` +
  `serving_unit`, e.g. "1 unit" egg, "200 post-cook grams" pasta), not
  normalized to per-100g. Seeded from `lib/foodCatalog.ts` via
  `services/foods.ts` + `pnpm seed:foods`. Mirrors `fueling_products`/
  `lib/fuelingCatalog.ts` exactly — same case-insensitive exact-name
  resolution (`findFoodByName`), same "unmatched name gets flagged, never
  guessed" rationale.
- **`meal_templates` / `meal_template_items`** — the athlete's usual meals,
  each a full day's eating grouped into breakfast/lunch/dinner/snack/
  post_workout slots. Seeded from `lib/mealTemplates.ts` via
  `services/mealTemplates.ts` + `pnpm seed:meals`. Some templates carry
  `block` (1, 2) matching Training Program blocks.
- **`meal_logs` / `meal_log_items`** — actual daily intake, food-level
  (mirrors `run_fueling_items`): `services/mealLogs.ts` logs either ad hoc
  (named foods + quantities), by copying one template slot's items, or by
  copying an ENTIRE template (`logWholeTemplateForDate`) for a date; sums a
  day's totals (`getDailyNutritionTotals`) and lists each logged meal
  (`listMealLogsForDate`) for display + undo (`deleteMealLog`, cascades to
  items).
- **`nutrition_goals`** — **modular by design**: `goal_key` is open TEXT, not
  a CHECK-constrained vocabulary, so a new goal is a seed-data change, never
  a migration. `lib/nutritionGoals.ts` documents the keys the app currently
  understands: point targets (`water_base_l`, `vitamin_c_mg`, `zinc_mg`,
  `vitamin_d_iu`) and **ranges**, modeled as a `_min`/`_max` pair of rows
  rather than widening the schema (`kcal_min`/`kcal_max`,
  `creatine_g_min`/`creatine_g_max`). No protein/carbs/fat gram split is
  stated in the training program itself — see the macro-formula item below.
  **Values are never hardcoded/committed** — same rationale as the Knowledge
  Vault Policy, applied to numeric targets instead of copyrighted text.
  `scripts/seed-nutrition-goals.ts` reads a private, zod-validated JSON file
  (`AGON_NUTRITION_GOALS_PATH`, default `config/nutrition-goals.local.json`,
  gitignored via `config/*.local.json`) and upserts it into the table. The
  repo ships `config/nutrition-goals.example.json` with generic placeholder
  values (a new user copies it, fills in their own numbers, points the env
  var if they want a different path, and re-runs the seed — no code
  change).
  - **Water goal is dynamic, not a flat number**: base (`water_base_l`) +
    estimated sweat loss from that day's **planned** exercise
    (`services/nutritionGoals.ts` → `getWaterGoalForDate`). Reuses the
    existing sweat-rate baseline (`getBaselineSweatRate()`, same as the
    fueling model in `.claude/rules/premium-parity.md`) × an estimated
    duration: for a planned run, `target_distance_km` × the athlete's own
    recent average pace (last 20 runs; falls back to a documented constant
    only when there's no run history yet); for a planned lift session (no
    target duration in `planned_sessions`), a flat assumed duration × a
    lower assumed lift sweat rate (`getAthleteProfile().liftSweatRateLPerH`,
    `lib/athleteProfile.ts`). Deliberately simple and documented (keep the
    adjustment model simple) — temperature/humidity/HR-based adjustment is
    the fuller `fct_run_fueling` model, still backlogged.
  - Unit-tested (`__tests__/lib/nutritionGoals.test.ts`): the water
    formula's pure math (`estimateRunWaterLossL`, `estimateLiftWaterLossL`,
    `computeWaterGoalL`).
- **Cronometer is the decided nutrition app** (daily intake logging happens
  in Cronometer, not Agon/Telegram) and is the eventual **primary**
  daily-intake source once its CSV import (backlogged, see Linear MZY-29)
  lands in `nutrition_days`. **No Telegram logging commands** — deliberately
  scoped out in favor of Cronometer. **PWA logging is an interim bridge**
  ahead of that import — a deliberate, scoped exception to the "PWA is
  read-mostly, writes stay in Telegram" principle. Scope is intentionally
  narrow: logging only resolves against the `foods` catalog
  (case-insensitive exact match) — no free-text/arbitrary macro entry, since
  that can't be priced. `services/mealLogs.ts` + `/api/nutrition/log` (POST:
  ad hoc items, one template slot, or a whole template;
  `/api/nutrition/log/[id]` DELETE: undo) are the write surface;
  `nutrition_days` stays the schema's intended landing spot for Cronometer —
  once the importer exists, `meal_logs` simply stops being the visible
  source (its totals show only while nonzero; `nutrition_days` takes over)
  with no redesign needed.
- **MCP tool — `nutrition_summary(date?)`** (`services/mcp/curated.ts`):
  water goal breakdown, calorie/creatine target ranges, supplement goals,
  logged intake (`meal_logs`, falling back to `nutrition_days` once that
  exists), and the usual-meal templates, as markdown. Reimplements the water
  formula on the MCP layer's own read-only pool (never imports the writable
  `services/db.ts` path, per the MCP read-only invariant).
- **PWA view — `/nutrition`** (`app/nutrition/page.tsx` →
  `/api/nutrition?date=` → `services/marts/nutrition.ts`, plus
  `components/MealLogForm.tsx` + `MealLogList.tsx`): today's water/kcal/
  creatine/supplement goals as stat tiles (kcal shown against logged intake
  with an under/in-range/over status color), today's logged meals with an
  undo button, a logging form (one-click "log this whole usual meal for
  today" per template, or an ad-hoc food+quantity picker), and the
  usual-meal list with macros for reference. No dbt mart backing the
  goals/templates/logging — current-state operational data, not a time
  series (forward-compatible with `nutrition_days` once Cronometer lands).
- **Macro (protein/carbs/fat) targets** — the training program states no
  macro split, only kcal. Formula: protein is bodyweight × g/kg directly;
  whatever calories remain after protein split between carbs and fat by a
  10%-point-step percentage, carbs prioritized. Pure formula
  `computeMacroTargets` (`lib/nutritionGoals.ts`, unit-tested — 4 cases): the
  min/max pairing is deliberately cross-wired (`remainingKcalMin = kcalMin −
  proteinKcalMAX`, `remainingKcalMax = kcalMax − proteinKcalMIN`) to bound
  the widest sensible range rather than understating it. Every input is a
  modular goal param, never hardcoded: `protein_g_per_kg_min`/`_max`,
  `carb_share_pct`/`fat_share_pct` (must sum to 100) join `kcal_min`/`_max`
  in the private config. **Output grams are derived at read time, never
  stored** — `services/nutritionGoals.ts` → `getMacroGoals()` multiplies by
  the athlete's LATEST logged `body_metrics.weight_kg` (falling back to
  `getAthleteProfile().weightKgFallback` only when none is logged yet), so
  targets track bodyweight automatically as new weigh-ins land — same
  "derive, don't snapshot" pattern as the water goal.
- **Still open**: the Cronometer CSV import + the `fct_nutrition_vs_targets`
  mart it unblocks — see Linear (MZY-29, MZY-33).

import { query } from '../db';
import { getWaterGoalForDate, getMacroGoals } from '../nutritionGoals';
import { getDailyNutritionTotals, listMealLogsForDate } from '../mealLogs';
import { NUTRITION_GOAL_KEYS } from '../../lib/nutritionGoals';
import type {
  NutritionResponse,
  NutritionGoalPoint,
  MealTemplateSummary,
  GoalRange,
} from '../../lib/marts';

// Read side of the /api/nutrition boundary. Unlike the other Phase-3 views,
// there's no dbt mart backing this yet — goals and templates are current-state
// config, not a time series, so this reads the operational tables directly
// (same tables services/nutritionGoals.ts / mealTemplates.ts / mealLogs.ts
// already own). `nutrition_days` is included because it's the intended landing
// table for a future Cronometer CSV import (Phase 2 backlog) — this view is
// forward-compatible with that without any redesign.

// goal_keys rendered specially (as a range or in the water card), so they're
// excluded from the generic "supplement goals" point-value list below.
const RANGE_GOAL_KEYS: readonly string[] = [
  NUTRITION_GOAL_KEYS.KCAL_MIN,
  NUTRITION_GOAL_KEYS.KCAL_MAX,
  NUTRITION_GOAL_KEYS.CREATINE_G_MIN,
  NUTRITION_GOAL_KEYS.CREATINE_G_MAX,
];

interface GoalRow {
  goal_key: string;
  value: string;
  unit: string;
}

function extractRange(
  rows: GoalRow[],
  minKey: string,
  maxKey: string,
): GoalRange | null {
  const min = rows.find((r) => r.goal_key === minKey);
  const max = rows.find((r) => r.goal_key === maxKey);
  if (!min || !max) return null;
  return { min: Number(min.value), max: Number(max.value), unit: min.unit };
}

async function allGoals(): Promise<GoalRow[]> {
  const { rows } = await query<GoalRow>(
    `SELECT goal_key, value, unit FROM public.nutrition_goals ORDER BY goal_key`,
  );
  return rows;
}

// Macro-formula PARAMETERS (bodyweight multiplier, carb/fat split %) — inputs
// to computeMacroTargets, never display targets themselves.
const MACRO_PARAM_KEYS: readonly string[] = [
  NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MIN,
  NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MAX,
  NUTRITION_GOAL_KEYS.CARB_SHARE_PCT,
  NUTRITION_GOAL_KEYS.FAT_SHARE_PCT,
];

function supplementGoalPoints(rows: GoalRow[]): NutritionGoalPoint[] {
  const excluded = new Set<string>([
    NUTRITION_GOAL_KEYS.WATER_BASE_L,
    ...RANGE_GOAL_KEYS,
    ...MACRO_PARAM_KEYS,
  ]);
  return rows
    .filter((r) => !excluded.has(r.goal_key))
    .map((r) => ({
      goalKey: r.goal_key,
      value: Number(r.value),
      unit: r.unit,
    }));
}

async function nutritionDayRow(
  date: string,
): Promise<NutritionResponse['nutritionDay']> {
  const { rows } = await query<{
    kcal: string | null;
    protein_g: string | null;
    carbs_g: string | null;
    fat_g: string | null;
    creatine_taken: boolean | null;
  }>(
    `SELECT kcal, protein_g, carbs_g, fat_g, creatine_taken
       FROM public.nutrition_days WHERE date = $1`,
    [date],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    kcal: Number(r.kcal ?? 0),
    proteinG: Number(r.protein_g ?? 0),
    carbsG: Number(r.carbs_g ?? 0),
    fatG: Number(r.fat_g ?? 0),
    creatineTaken: r.creatine_taken,
  };
}

async function mealTemplateSummaries(): Promise<MealTemplateSummary[]> {
  const { rows } = await query<{
    id: string;
    name: string;
    context: string | null;
    block: number | null;
    kcal: string | null;
    protein_g: string | null;
    carbs_g: string | null;
    fat_g: string | null;
  }>(
    `SELECT mt.id, mt.name, mt.context, mt.block,
            SUM(mti.quantity * f.kcal)      AS kcal,
            SUM(mti.quantity * f.protein_g) AS protein_g,
            SUM(mti.quantity * f.carbs_g)   AS carbs_g,
            SUM(mti.quantity * f.fat_g)     AS fat_g
       FROM public.meal_templates mt
       JOIN public.meal_template_items mti ON mti.meal_template_id = mt.id
       JOIN public.foods f ON f.id = mti.food_id
      GROUP BY mt.id, mt.name, mt.context, mt.block
      ORDER BY mt.block NULLS LAST, mt.name`,
  );
  const { rows: itemRows } = await query<{
    meal_template_id: string;
    meal_slot: string;
    food_id: string;
    quantity: string;
  }>(
    `SELECT meal_template_id, meal_slot, food_id, quantity
       FROM public.meal_template_items ORDER BY meal_template_id, item_order`,
  );
  return rows.map((r) => ({
    items: itemRows
      .filter((i) => i.meal_template_id === r.id)
      .map((i) => ({
        mealSlot: i.meal_slot,
        foodId: i.food_id,
        quantity: Number(i.quantity),
      })),
    id: r.id,
    name: r.name,
    context: r.context,
    block: r.block,
    totals: {
      kcal: Math.round(Number(r.kcal ?? 0)),
      proteinG: Math.round(Number(r.protein_g ?? 0)),
      carbsG: Math.round(Number(r.carbs_g ?? 0)),
      fatG: Math.round(Number(r.fat_g ?? 0)),
    },
  }));
}

export async function getNutritionSummary(
  date: string,
): Promise<NutritionResponse> {
  const [water, goalRows, macros, logged, mealLogs, nutritionDay, templates] =
    await Promise.all([
      getWaterGoalForDate(date),
      allGoals(),
      getMacroGoals(),
      getDailyNutritionTotals(date),
      listMealLogsForDate(date),
      nutritionDayRow(date),
      mealTemplateSummaries(),
    ]);

  return {
    date,
    water,
    kcalGoal: extractRange(
      goalRows,
      NUTRITION_GOAL_KEYS.KCAL_MIN,
      NUTRITION_GOAL_KEYS.KCAL_MAX,
    ),
    creatineGoal: extractRange(
      goalRows,
      NUTRITION_GOAL_KEYS.CREATINE_G_MIN,
      NUTRITION_GOAL_KEYS.CREATINE_G_MAX,
    ),
    proteinGoal: macros && {
      min: macros.proteinG.min,
      max: macros.proteinG.max,
      unit: 'g',
    },
    carbsGoal: macros && {
      min: macros.carbsG.min,
      max: macros.carbsG.max,
      unit: 'g',
    },
    fatGoal: macros && {
      min: macros.fatG.min,
      max: macros.fatG.max,
      unit: 'g',
    },
    supplementGoals: supplementGoalPoints(goalRows),
    loggedTotals: {
      kcal: Math.round(logged.kcal),
      proteinG: Math.round(logged.proteinG),
      carbsG: Math.round(logged.carbsG),
      fatG: Math.round(logged.fatG),
    },
    todaysMealLogs: mealLogs,
    nutritionDay,
    mealTemplates: templates,
  };
}

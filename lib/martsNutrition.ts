// Nutrition shapes for the PWA (split out of lib/marts.ts for the file-size
// budget; re-exported from there, so imports of '@/lib/marts' are unchanged).
// Same rule as lib/marts.ts: lib/, not services/, and JSON-serializable.

// ── Nutrition (decision 2026-08-24) ─────────────────────────────────────────────

/** Today's (or `?date=`'s) water goal, broken into its base + exercise-loss parts. */
export interface WaterGoal {
  baseL: number;
  exerciseLossL: number;
  goalL: number;
}

/** One modular daily supplement/nutrition target (nutrition_goals row). */
export interface NutritionGoalPoint {
  goalKey: string;
  value: number;
  unit: string;
}

/** Macro totals — used for both a template's totals and a day's logged/actual totals. */
export interface MacroTotals {
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** One usual-meal template, with its computed macro totals. */
export interface MealTemplateSummary {
  id: string;
  name: string;
  context: string | null;
  block: number | null;
  totals: MacroTotals;
  /** What logging the whole template writes — built into rows on the device (MZY-206). */
  items: { mealSlot: string; foodId: string; quantity: number }[];
}

/** A min/max target range (kcal, creatine, ...) — null when not both bounds are seeded. */
export interface GoalRange {
  min: number;
  max: number;
  unit: string;
}

/** One food item within a logged meal, at its logged quantity. */
export interface MealLogItemSummary {
  /** meal_log_items.id — the edit UI writes quantity changes against it. */
  id: string;
  foodName: string;
  quantity: number;
}

/** One logged meal (a meal_logs row) with its items and computed totals. */
export interface MealLogSummary {
  id: string;
  mealSlot: string;
  source: string;
  /** The template it was logged from, if any. */
  templateName: string | null;
  notes: string | null;
  items: MealLogItemSummary[];
  totals: MacroTotals;
}

/** One catalog food, as returned by GET /api/nutrition/foods (per-serving macros). */
export interface FoodOption {
  id: string;
  name: string;
  servingQty: number;
  servingUnit: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** GET /api/nutrition/foods response. */
export interface FoodsResponse {
  foods: FoodOption[];
}

/** GET /api/nutrition response, scoped to one date (default today). */
export interface NutritionResponse {
  /** YYYY-MM-DD the response is scoped to. */
  date: string;
  water: WaterGoal;
  /** Daily calorie target range, from the training program — null if not seeded. */
  kcalGoal: GoalRange | null;
  /** Daily creatine target range, from the training program — null if not seeded. */
  creatineGoal: GoalRange | null;
  /** Daily protein target (g), from bodyweight x g/kg — null if the formula params aren't seeded. */
  proteinGoal: GoalRange | null;
  /** Daily carbs target (g), from the calories remaining after protein — null if not seeded. */
  carbsGoal: GoalRange | null;
  /** Daily fat target (g), from the calories remaining after protein — null if not seeded. */
  fatGoal: GoalRange | null;
  /** Point-value goals other than water/kcal/creatine/macros (vitamin C, zinc, vitamin D, ...). */
  supplementGoals: NutritionGoalPoint[];
  /** Structured intake logged for `date` via meal_logs (services/mealLogs.ts). */
  loggedTotals: MacroTotals;
  /** Each logged meal for `date`, for display + deletion in the PWA. */
  todaysMealLogs: MealLogSummary[];
  /** The coarse daily row from `nutrition_days` for `date`, if any (e.g. a future Cronometer import). */
  nutritionDay: (MacroTotals & { creatineTaken: boolean | null }) | null;
  /** The athlete's usual meals, for reference/quick logging. */
  mealTemplates: MealTemplateSummary[];
}

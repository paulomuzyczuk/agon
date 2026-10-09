// Modular daily nutrition goals (CLAUDE.md nutrition decision 2026-08-24).
// `nutrition_goals` is an open key/value table on purpose — this file defines
// only the keys the app currently *understands* (drives the water formula,
// documents the supplement targets), not a closed vocabulary. A new goal is a
// new row via scripts/seed-nutrition-goals.ts, never a schema change.
//
// The actual numeric values are NEVER hardcoded here or anywhere else in code —
// per-user values live in a private, gitignored config file (see
// scripts/seed-nutrition-goals.ts + config/nutrition-goals.example.json) so a
// new user sets their own goals without touching code.

export const NUTRITION_GOAL_KEYS = {
  WATER_BASE_L: 'water_base_l',
  VITAMIN_C_MG: 'vitamin_c_mg',
  ZINC_MG: 'zinc_mg',
  VITAMIN_D_IU: 'vitamin_d_iu',
  // Ranges (CLAUDE.md Training Program Summary states these as ranges, not
  // single numbers) — modeled as two goal_key rows rather than widening the
  // table's schema, same "modular, no migration" approach as everything else
  // here. KCAL applies to Blocks 1–2 per the plan; Block 3 states none.
  KCAL_MIN: 'kcal_min',
  KCAL_MAX: 'kcal_max',
  CREATINE_G_MIN: 'creatine_g_min',
  CREATINE_G_MAX: 'creatine_g_max',
  // Macro-formula PARAMETERS (decision 2026-08-24, second pass, athlete-
  // directed): "start with 1.8g-2.2g per kg and distribute the rest also with
  // 10% intervals prioritizing carbs over fat." These are inputs to
  // computeMacroTargets() below, not targets to display directly — the
  // resulting protein/carbs/fat gram RANGES are derived at read time (like the
  // water goal), never stored, so they track the athlete's latest logged
  // bodyweight automatically. carb_share_pct + fat_share_pct must sum to 100.
  PROTEIN_G_PER_KG_MIN: 'protein_g_per_kg_min',
  PROTEIN_G_PER_KG_MAX: 'protein_g_per_kg_max',
  CARB_SHARE_PCT: 'carb_share_pct',
  FAT_SHARE_PCT: 'fat_share_pct',
} as const;

export interface NutritionGoalSpec {
  goalKey: string;
  value: number;
  unit: string;
  notes?: string | null;
}

/**
 * A day's estimated water loss (litres) from planned exercise, on top of the
 * base daily goal. Kept simple and documented per CLAUDE.md Premium-Parity #5
 * ("keep the adjustment model simple"): baseline sweat rate × estimated
 * duration, no temperature/humidity/HR adjustment yet (that's the fuller
 * fct_run_fueling model, still backlogged).
 */
export function estimateRunWaterLossL(
  distanceKm: number,
  paceSPerKm: number,
  sweatRateLPerH: number,
): number {
  const durationH = (distanceKm * paceSPerKm) / 3600;
  return durationH * sweatRateLPerH;
}

export interface LongRunFuelingEstimate {
  durationH: number;
  waterL: number;
  carbsGMin: number;
  carbsGMax: number;
  sodiumMg: number;
}

/**
 * Suggested water/carbs/sodium for a long run — the calendar long-run reminder's
 * version of the same simple model as estimateRunWaterLossL: duration from
 * distance × pace, water from sweat rate, carbs from the general g/h guideline,
 * sodium from sweat volume × concentration. All rate/guideline inputs are
 * caller-supplied (see lib/constants.ts), never hardcoded here.
 */
export function estimateLongRunFueling(
  distanceKm: number,
  paceSPerKm: number,
  sweatRateLPerH: number,
  sodiumMgPerL: number,
  carbsGPerHMin: number,
  carbsGPerHMax: number,
): LongRunFuelingEstimate {
  const durationH = (distanceKm * paceSPerKm) / 3600;
  const waterL = estimateRunWaterLossL(distanceKm, paceSPerKm, sweatRateLPerH);
  return {
    durationH: Math.round(durationH * 100) / 100,
    waterL: Math.round(waterL * 10) / 10,
    carbsGMin: Math.round(durationH * carbsGPerHMin),
    carbsGMax: Math.round(durationH * carbsGPerHMax),
    sodiumMg: Math.round(waterL * sodiumMgPerL),
  };
}

/** Flat estimate for a planned lift session — see lib/constants.ts for the assumptions. */
export function estimateLiftWaterLossL(
  liftAssumedDurationH: number,
  liftSweatRateLPerH: number,
): number {
  return liftAssumedDurationH * liftSweatRateLPerH;
}

/** Today's water goal: base + exercise loss, rounded to 3dp (matches NUMERIC(10,3)). */
export function computeWaterGoalL(baseL: number, exerciseLossL: number): number {
  return Math.round((baseL + Math.max(0, exerciseLossL)) * 1000) / 1000;
}

export interface GramRange {
  min: number;
  max: number;
}

export interface MacroTargets {
  proteinG: GramRange;
  carbsG: GramRange;
  fatG: GramRange;
}

/**
 * Protein/carbs/fat gram RANGES from bodyweight + the daily kcal target range.
 * Formula (athlete-directed, decision 2026-08-24): protein is g/kg bodyweight
 * directly (`proteinGPerKgMin`/`Max`, e.g. 1.8–2.2); whatever calories remain
 * after protein split between carbs and fat by `carbSharePct`/`fatSharePct`
 * (10%-point steps, carbs prioritized — e.g. 70/30), 4 kcal/g for protein and
 * carbs, 9 kcal/g for fat.
 *
 * The min/max pairing is deliberately cross-wired to bound the widest sensible
 * range: `remainingKcalMin` pairs the LOW end of kcal with the HIGH end of
 * protein (the tightest case — little kcal, lots spent on protein), and
 * `remainingKcalMax` pairs the HIGH end of kcal with the LOW end of protein
 * (the most generous case). Using kcalMin−proteinMin (or kcalMax−proteinMax)
 * instead would understate the true range.
 */
export function computeMacroTargets(params: {
  weightKg: number;
  kcalMin: number;
  kcalMax: number;
  proteinGPerKgMin: number;
  proteinGPerKgMax: number;
  carbSharePct: number;
  fatSharePct: number;
}): MacroTargets {
  const {
    weightKg,
    kcalMin,
    kcalMax,
    proteinGPerKgMin,
    proteinGPerKgMax,
    carbSharePct,
    fatSharePct,
  } = params;

  const proteinGMin = weightKg * proteinGPerKgMin;
  const proteinGMax = weightKg * proteinGPerKgMax;

  const remainingKcalMin = Math.max(0, kcalMin - proteinGMax * 4);
  const remainingKcalMax = Math.max(0, kcalMax - proteinGMin * 4);

  const carbShare = carbSharePct / 100;
  const fatShare = fatSharePct / 100;

  return {
    proteinG: { min: Math.round(proteinGMin), max: Math.round(proteinGMax) },
    carbsG: {
      min: Math.round((remainingKcalMin * carbShare) / 4),
      max: Math.round((remainingKcalMax * carbShare) / 4),
    },
    fatG: {
      min: Math.round((remainingKcalMin * fatShare) / 9),
      max: Math.round((remainingKcalMax * fatShare) / 9),
    },
  };
}

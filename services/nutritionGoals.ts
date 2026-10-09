import { query } from './db';
import { getBaselineSweatRate } from './sweat';
import {
  NUTRITION_GOAL_KEYS,
  estimateRunWaterLossL,
  estimateLiftWaterLossL,
  computeWaterGoalL,
  computeMacroTargets,
  type NutritionGoalSpec,
  type MacroTargets,
} from '../lib/nutritionGoals';
import { DEFAULT_EASY_PACE_S_PER_KM, LIFT_ASSUMED_DURATION_H } from '../lib/constants';
import { getAthleteProfile } from '../lib/athleteProfile';

// Reads/writes for the modular `nutrition_goals` table, plus the water-goal
// orchestration (pure formula lives in lib/nutritionGoals.ts; this file wires
// in the DB-backed inputs: the goal's base value, planned exercise for the day,
// and the athlete's current sweat rate / recent pace).

/** Upsert one goal (idempotent on goal_key). Used by the seed script. */
export async function upsertNutritionGoal(g: NutritionGoalSpec): Promise<void> {
  await query(
    `INSERT INTO public.nutrition_goals (goal_key, value, unit, notes)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (goal_key) DO UPDATE SET
       value = EXCLUDED.value, unit = EXCLUDED.unit, notes = EXCLUDED.notes`,
    [g.goalKey, g.value, g.unit, g.notes ?? null],
  );
}

/** Current value of one goal, or null if it hasn't been seeded. */
export async function getGoalValue(goalKey: string): Promise<number | null> {
  const { rows } = await query<{ value: string }>(
    `SELECT value FROM public.nutrition_goals WHERE goal_key = $1`,
    [goalKey],
  );
  return rows[0] ? Number(rows[0].value) : null;
}

export interface NutritionGoal {
  goalKey: string;
  value: number;
  unit: string;
  notes: string | null;
}

/** All currently-set goals, for a status/summary view. */
export async function listNutritionGoals(): Promise<NutritionGoal[]> {
  const { rows } = await query<{
    goal_key: string;
    value: string;
    unit: string;
    notes: string | null;
  }>(`SELECT goal_key, value, unit, notes FROM public.nutrition_goals ORDER BY goal_key`);
  return rows.map((r) => ({
    goalKey: r.goal_key,
    value: Number(r.value),
    unit: r.unit,
    notes: r.notes,
  }));
}

/** Athlete's recent average pace, for models that need an assumed run duration
 * (the water goal here, and the calendar long-run fueling reminder). */
export async function recentAveragePaceSPerKm(): Promise<number | null> {
  const { rows } = await query<{ avg_pace: string | null }>(
    `SELECT avg(avg_pace_s_per_km) AS avg_pace
       FROM (
         SELECT avg_pace_s_per_km FROM public.runs
          WHERE avg_pace_s_per_km IS NOT NULL
          ORDER BY date DESC
          LIMIT 20
       ) recent`,
  );
  const v = rows[0]?.avg_pace;
  return v != null ? Number(v) : null;
}

interface PlannedSessionForWater {
  session_kind: string;
  target_distance_km: string | null;
}

async function plannedSessionsOnDate(date: string): Promise<PlannedSessionForWater[]> {
  const { rows } = await query<PlannedSessionForWater>(
    `SELECT session_kind, target_distance_km
       FROM public.planned_sessions
      WHERE date = $1 AND session_kind IN ('run','lift')`,
    [date],
  );
  return rows;
}

export interface WaterGoalResult {
  baseL: number;
  exerciseLossL: number;
  goalL: number;
}

/**
 * Today's water goal: the base daily target plus estimated sweat loss from
 * whatever is planned for `date`. Falls back gracefully when inputs are
 * missing (no goal seeded yet, no run history for a pace estimate, no planned
 * sessions) rather than throwing — a missing water goal shouldn't break a
 * broader nutrition summary.
 */
export async function getWaterGoalForDate(date: string): Promise<WaterGoalResult> {
  const baseL = (await getGoalValue(NUTRITION_GOAL_KEYS.WATER_BASE_L)) ?? 2.5;
  const sessions = await plannedSessionsOnDate(date);

  let exerciseLossL = 0;
  if (sessions.some((s) => s.session_kind === 'run' || s.session_kind === 'lift')) {
    const sweatRateLPerH = await getBaselineSweatRate();
    const paceSPerKm = (await recentAveragePaceSPerKm()) ?? DEFAULT_EASY_PACE_S_PER_KM;

    for (const s of sessions) {
      if (s.session_kind === 'run' && s.target_distance_km) {
        exerciseLossL += estimateRunWaterLossL(
          Number(s.target_distance_km),
          paceSPerKm,
          sweatRateLPerH,
        );
      } else if (s.session_kind === 'lift') {
        exerciseLossL += estimateLiftWaterLossL(
          LIFT_ASSUMED_DURATION_H,
          getAthleteProfile().liftSweatRateLPerH,
        );
      }
    }
  }

  return {
    baseL,
    exerciseLossL: Math.round(exerciseLossL * 1000) / 1000,
    goalL: computeWaterGoalL(baseL, exerciseLossL),
  };
}

async function latestBodyWeightKg(): Promise<number> {
  const { rows } = await query<{ weight_kg: string | null }>(
    `SELECT weight_kg FROM public.body_metrics
      WHERE weight_kg IS NOT NULL
      ORDER BY date DESC, created_at DESC LIMIT 1`,
  );
  return rows[0]?.weight_kg != null ? Number(rows[0].weight_kg) : getAthleteProfile().weightKgFallback;
}

/**
 * Protein/carbs/fat gram target ranges (see lib/nutritionGoals.ts
 * computeMacroTargets), derived at read time from the latest logged bodyweight
 * + the kcal range + the athlete's macro-formula goal params. Returns null
 * when any required param isn't seeded — a partially-configured formula
 * shouldn't produce a misleading number.
 */
export async function getMacroGoals(): Promise<MacroTargets | null> {
  const [kcalMin, kcalMax, proteinMin, proteinMax, carbPct, fatPct] = await Promise.all([
    getGoalValue(NUTRITION_GOAL_KEYS.KCAL_MIN),
    getGoalValue(NUTRITION_GOAL_KEYS.KCAL_MAX),
    getGoalValue(NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MIN),
    getGoalValue(NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MAX),
    getGoalValue(NUTRITION_GOAL_KEYS.CARB_SHARE_PCT),
    getGoalValue(NUTRITION_GOAL_KEYS.FAT_SHARE_PCT),
  ]);
  if (
    kcalMin == null ||
    kcalMax == null ||
    proteinMin == null ||
    proteinMax == null ||
    carbPct == null ||
    fatPct == null
  ) {
    return null;
  }

  const weightKg = await latestBodyWeightKg();
  return computeMacroTargets({
    weightKg,
    kcalMin,
    kcalMax,
    proteinGPerKgMin: proteinMin,
    proteinGPerKgMax: proteinMax,
    carbSharePct: carbPct,
    fatSharePct: fatPct,
  });
}

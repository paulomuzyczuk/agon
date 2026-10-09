import { readQuery } from './readonlyDb';
import { mdTable } from './curated';
import {
  DEFAULT_EASY_PACE_S_PER_KM,
  LIFT_ASSUMED_DURATION_H,
} from '../../lib/constants';
import { getAthleteProfile } from '../../lib/athleteProfile';
import {
  SESSION_SELECT,
  SESSION_FROM,
  RESOLVED_DATE,
  resolveSessionRow,
  type SessionRow,
} from '../plannedSessionView';
import {
  NUTRITION_GOAL_KEYS,
  estimateRunWaterLossL,
  estimateLiftWaterLossL,
  computeWaterGoalL,
  computeMacroTargets,
} from '../../lib/nutritionGoals';

// Curated read-only nutrition tool. Split out of services/mcp/curated.ts
// (already over the 500-line file-size budget before this feature — see
// scripts/check-file-size-budget.mjs) rather than growing that file
// further, same precedent as curatedRides.ts. Same read-only pool / guard
// idiom as curated.ts.

/**
 * Water/supplement goals for a date (default today), the day's water goal
 * broken into base + estimated exercise loss, logged intake so far, and the
 * usual-meal templates for reference. Mirrors services/marts/nutrition.ts but
 * reimplemented on the read-only pool (this layer never imports the writable
 * services/db.ts path) — same pure formulas from lib/nutritionGoals.ts.
 */
export async function nutritionSummary(dateISO?: string): Promise<string> {
  const date = dateISO ?? new Date().toISOString().slice(0, 10);

  const goals = await readQuery<{
    goal_key: string;
    value: string;
    unit: string;
  }>(
    `SELECT goal_key, value, unit FROM public.nutrition_goals ORDER BY goal_key`,
  );
  const baseL =
    Number(
      goals.find((g) => g.goal_key === NUTRITION_GOAL_KEYS.WATER_BASE_L)?.value,
    ) || 2.5;
  const rangeKeys = new Set<string>([
    NUTRITION_GOAL_KEYS.KCAL_MIN,
    NUTRITION_GOAL_KEYS.KCAL_MAX,
    NUTRITION_GOAL_KEYS.CREATINE_G_MIN,
    NUTRITION_GOAL_KEYS.CREATINE_G_MAX,
  ]);
  const macroParamKeys = new Set<string>([
    NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MIN,
    NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MAX,
    NUTRITION_GOAL_KEYS.CARB_SHARE_PCT,
    NUTRITION_GOAL_KEYS.FAT_SHARE_PCT,
  ]);
  const supplementRows = goals.filter(
    (g) =>
      g.goal_key !== NUTRITION_GOAL_KEYS.WATER_BASE_L &&
      !rangeKeys.has(g.goal_key) &&
      !macroParamKeys.has(g.goal_key),
  );
  const rangeText = (minKey: string, maxKey: string): string | null => {
    const min = goals.find((g) => g.goal_key === minKey);
    const max = goals.find((g) => g.goal_key === maxKey);
    return min && max
      ? `${Number(min.value)}–${Number(max.value)} ${min.unit}`
      : null;
  };
  const kcalRange = rangeText(
    NUTRITION_GOAL_KEYS.KCAL_MIN,
    NUTRITION_GOAL_KEYS.KCAL_MAX,
  );
  const creatineRange = rangeText(
    NUTRITION_GOAL_KEYS.CREATINE_G_MIN,
    NUTRITION_GOAL_KEYS.CREATINE_G_MAX,
  );

  // Protein/carbs/fat gram ranges, derived from the latest logged bodyweight —
  // same formula + rationale as services/nutritionGoals.ts getMacroGoals()
  // (kept separate: the MCP layer never imports the writable services/db.ts path).
  let macroText: string | null = null;
  const kcalMinG = goals.find(
    (g) => g.goal_key === NUTRITION_GOAL_KEYS.KCAL_MIN,
  );
  const kcalMaxG = goals.find(
    (g) => g.goal_key === NUTRITION_GOAL_KEYS.KCAL_MAX,
  );
  const proteinMinG = goals.find(
    (g) => g.goal_key === NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MIN,
  );
  const proteinMaxG = goals.find(
    (g) => g.goal_key === NUTRITION_GOAL_KEYS.PROTEIN_G_PER_KG_MAX,
  );
  const carbPctG = goals.find(
    (g) => g.goal_key === NUTRITION_GOAL_KEYS.CARB_SHARE_PCT,
  );
  const fatPctG = goals.find(
    (g) => g.goal_key === NUTRITION_GOAL_KEYS.FAT_SHARE_PCT,
  );
  if (
    kcalMinG &&
    kcalMaxG &&
    proteinMinG &&
    proteinMaxG &&
    carbPctG &&
    fatPctG
  ) {
    const weightRows = await readQuery<{ weight_kg: string | null }>(
      `SELECT weight_kg FROM public.body_metrics
        WHERE weight_kg IS NOT NULL
        ORDER BY date DESC, created_at DESC LIMIT 1`,
    );
    const weightKg =
      weightRows[0]?.weight_kg != null
        ? Number(weightRows[0].weight_kg)
        : getAthleteProfile().weightKgFallback;
    const macros = computeMacroTargets({
      weightKg,
      kcalMin: Number(kcalMinG.value),
      kcalMax: Number(kcalMaxG.value),
      proteinGPerKgMin: Number(proteinMinG.value),
      proteinGPerKgMax: Number(proteinMaxG.value),
      carbSharePct: Number(carbPctG.value),
      fatSharePct: Number(fatPctG.value),
    });
    macroText =
      `protein ${macros.proteinG.min}–${macros.proteinG.max} g, ` +
      `carbs ${macros.carbsG.min}–${macros.carbsG.max} g, ` +
      `fat ${macros.fatG.min}–${macros.fatG.max} g ` +
      `(from ${weightKg} kg bodyweight)`;
  }

  // The day's sessions as RESOLVED against session_adjustments (MZY-265): a
  // session the athlete moved counts on the day it now sits, with any
  // hand-edited distance; skipped sessions cost no water.
  const sessions = (
    await readQuery<SessionRow>(
      `SELECT ${SESSION_SELECT}
       ${SESSION_FROM}
        WHERE ${RESOLVED_DATE} = $1
          AND p.session_kind IN ('run','lift')
          AND p.status <> 'skipped'`,
      [date],
    )
  ).map((r) => ({
    session_kind: r.session_kind,
    target_distance_km: resolveSessionRow(r).resolved.targetDistanceKm,
  }));

  let exerciseLossL = 0;
  if (sessions.length > 0) {
    const rateRows = await readQuery<{ rate: string | null }>(
      `SELECT sweat_rate_l_per_h AS rate FROM public.sweat_observations
        WHERE sweat_rate_l_per_h IS NOT NULL
        ORDER BY date DESC, created_at DESC LIMIT 1`,
    );
    const sweatRateLPerH =
      rateRows[0]?.rate != null
        ? Number(rateRows[0].rate)
        : getAthleteProfile().sweatRateBaselineLPerH;

    const paceRows = await readQuery<{ avg_pace: string | null }>(
      `SELECT avg(avg_pace_s_per_km) AS avg_pace FROM (
         SELECT avg_pace_s_per_km FROM public.runs
          WHERE avg_pace_s_per_km IS NOT NULL ORDER BY date DESC LIMIT 20
       ) recent`,
    );
    const paceSPerKm =
      paceRows[0]?.avg_pace != null
        ? Number(paceRows[0].avg_pace)
        : DEFAULT_EASY_PACE_S_PER_KM;

    for (const s of sessions) {
      if (s.session_kind === 'run' && s.target_distance_km) {
        exerciseLossL += estimateRunWaterLossL(
          s.target_distance_km,
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
  const goalL = computeWaterGoalL(baseL, exerciseLossL);

  const loggedRows = await readQuery<{
    kcal: string | null;
    protein_g: string | null;
    carbs_g: string | null;
    fat_g: string | null;
  }>(
    `SELECT SUM(mli.quantity*f.kcal) kcal, SUM(mli.quantity*f.protein_g) protein_g,
            SUM(mli.quantity*f.carbs_g) carbs_g, SUM(mli.quantity*f.fat_g) fat_g
       FROM public.meal_log_items mli
       JOIN public.meal_logs ml ON ml.id = mli.meal_log_id
       JOIN public.foods f ON f.id = mli.food_id
      WHERE ml.date = $1 AND ml.deleted_at IS NULL AND mli.deleted_at IS NULL`,
    [date],
  );

  const templates = await readQuery<{ name: string; block: number | null }>(
    `SELECT name, block FROM public.meal_templates ORDER BY block NULLS LAST, name`,
  );

  const lines = [
    `## Nutrition — ${date}`,
    '',
    `**Water goal:** ${goalL.toFixed(2)} L (${baseL} L base` +
      (exerciseLossL > 0
        ? ` + ${exerciseLossL.toFixed(2)} L estimated from planned exercise)`
        : ', no planned exercise today)'),
    kcalRange
      ? `**Calorie target:** ${kcalRange}/day (training program)`
      : null,
    macroText ? `**Macro targets:** ${macroText}` : null,
    creatineRange
      ? `**Creatine target:** ${creatineRange}/day (training program)`
      : null,
    '',
    '**Supplement goals:**',
    mdTable(
      ['goal', 'target'],
      supplementRows.map((g) => [g.goal_key, `${Number(g.value)} ${g.unit}`]),
    ),
    '',
    `**Logged intake today:** ${
      loggedRows[0]?.kcal
        ? `${Math.round(Number(loggedRows[0].kcal))} kcal, ${Math.round(Number(loggedRows[0].protein_g ?? 0))}g protein, ${Math.round(Number(loggedRows[0].carbs_g ?? 0))}g carbs, ${Math.round(Number(loggedRows[0].fat_g ?? 0))}g fat`
        : 'none logged (actual daily intake is tracked in Cronometer)'
    }`,
    '',
    '**Usual meal templates:**',
    templates
      .map((t) => `- ${t.name}${t.block != null ? ` (Block ${t.block})` : ''}`)
      .join('\n'),
  ];
  return lines.join('\n');
}

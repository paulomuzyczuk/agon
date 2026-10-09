import { query } from './db';
import {
  computeFuelingBalance,
  type FuelingActivity,
  type FuelingBalance,
  type FuelingIntake,
} from '../lib/fuelingModel';
import type { AthleteProfile } from '../lib/athleteProfile';
import { getBaselineSweatRate } from './sweat';

// DB access for the fueling-balance backfill (MZY-64). The model is pure
// (lib/fuelingModel.ts); this module only loads each activity's inputs and
// upserts the derived row. Runs and rides share one code path — the tables
// are siblings with identical shapes, picked from a fixed map (never
// interpolated from input). Orchestration: scripts/backfill-fueling-balance.ts;
// recomputeFuelingBalance redoes one activity after a hand correction (MZY-253).

/** Below this an activity is only modelled when intake was actually logged. */
export const FUELING_MODEL_MIN_DURATION_S = 3600;

const TABLES: Record<
  FuelingActivity,
  { activity: string; items: string; balance: string; fk: string }
> = {
  run: {
    activity: 'public.runs',
    items: 'public.run_fueling_items',
    balance: 'public.run_fueling_balance',
    fk: 'run_id',
  },
  ride: {
    activity: 'public.rides',
    items: 'public.ride_fueling_items',
    balance: 'public.ride_fueling_balance',
    fk: 'ride_id',
  },
};

export interface FuelingCandidate {
  id: string;
  date: string;
  distanceKm: number;
  durationS: number;
  avgHr: number | null;
  tempC: number | null;
  humidityPct: number | null;
  /** Latest weigh-in on/before the activity date; null → caller uses the profile fallback. */
  bodyMassKg: number | null;
  /** Summed over resolved fueling items; null when none were logged. */
  intake: FuelingIntake | null;
}

/** Activities worth modelling: long enough to matter, or with logged intake. */
export async function loadFuelingCandidates(
  activity: FuelingActivity,
  ids?: readonly string[],
): Promise<FuelingCandidate[]> {
  const t = TABLES[activity];
  const { rows } = await query<{
    id: string;
    date: string;
    distance_km: string;
    duration_s: number;
    avg_hr: number | null;
    temp_c: string | null;
    humidity_pct: string | null;
    body_mass_kg: string | null;
    n_items: string;
    water_ml: string | null;
    carbs_g: string | null;
    sodium_mg: string | null;
  }>(
    `SELECT a.id, a.date::text AS date, a.distance_km, a.duration_s, a.avg_hr,
            a.temp_c, a.humidity_pct,
            (SELECT b.weight_kg FROM public.body_metrics b
              WHERE b.date <= a.date AND b.weight_kg IS NOT NULL
              ORDER BY b.date DESC, b.created_at DESC LIMIT 1) AS body_mass_kg,
            count(i.id) AS n_items,
            sum(i.quantity * coalesce(p.water_ml, 0))  AS water_ml,
            sum(i.quantity * coalesce(p.carbs_g, 0))   AS carbs_g,
            sum(i.quantity * coalesce(p.sodium_mg, 0)) AS sodium_mg
       FROM ${t.activity} a
       LEFT JOIN ${t.items} i ON i.${t.fk} = a.id
       LEFT JOIN public.fueling_products p ON p.id = i.product_id
      WHERE $2::uuid[] IS NULL OR a.id = ANY($2::uuid[])
      GROUP BY a.id
     HAVING a.duration_s >= $1 OR count(i.id) > 0
      ORDER BY a.date`,
    [FUELING_MODEL_MIN_DURATION_S, ids ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    distanceKm: Number(r.distance_km),
    durationS: r.duration_s,
    avgHr: r.avg_hr,
    tempC: r.temp_c == null ? null : Number(r.temp_c),
    humidityPct: r.humidity_pct == null ? null : Number(r.humidity_pct),
    bodyMassKg: r.body_mass_kg == null ? null : Number(r.body_mass_kg),
    intake:
      Number(r.n_items) > 0
        ? {
            waterMl: Number(r.water_ml),
            carbsG: Number(r.carbs_g),
            sodiumMg: Number(r.sodium_mg),
          }
        : null,
  }));
}

export interface FuelingBalanceRow {
  id: string;
  durationS: number;
  avgHr: number | null;
  baselineSweatRateLPerH: number;
  sweatSodiumMgPerL: number;
  bodyMassKg: number;
  balance: FuelingBalance;
}

/** Idempotent upsert of an activity's balance (PK on the activity id — recompute overwrites). */
export async function upsertFuelingBalance(
  activity: FuelingActivity,
  row: FuelingBalanceRow,
): Promise<void> {
  const t = TABLES[activity];
  const b = row.balance;
  await query(
    `INSERT INTO ${t.balance}
       (${t.fk}, duration_s, avg_hr, intensity_method, intensity_factor,
        heat_factor, baseline_sweat_rate_l_per_h, sweat_sodium_mg_per_l,
        body_mass_kg, est_sweat_rate_l_per_h, est_sweat_loss_l,
        est_sodium_loss_mg, carbs_target_min_g_per_h, carbs_target_max_g_per_h,
        intake_logged, fluid_intake_l, net_fluid_l, body_mass_loss_pct,
        sodium_intake_mg, net_sodium_mg, carbs_g, carbs_per_h, dehydrated,
        under_fueled, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23,$24, now())
     ON CONFLICT (${t.fk}) DO UPDATE SET
       duration_s                  = EXCLUDED.duration_s,
       avg_hr                      = EXCLUDED.avg_hr,
       intensity_method            = EXCLUDED.intensity_method,
       intensity_factor            = EXCLUDED.intensity_factor,
       heat_factor                 = EXCLUDED.heat_factor,
       baseline_sweat_rate_l_per_h = EXCLUDED.baseline_sweat_rate_l_per_h,
       sweat_sodium_mg_per_l       = EXCLUDED.sweat_sodium_mg_per_l,
       body_mass_kg                = EXCLUDED.body_mass_kg,
       est_sweat_rate_l_per_h      = EXCLUDED.est_sweat_rate_l_per_h,
       est_sweat_loss_l            = EXCLUDED.est_sweat_loss_l,
       est_sodium_loss_mg          = EXCLUDED.est_sodium_loss_mg,
       carbs_target_min_g_per_h    = EXCLUDED.carbs_target_min_g_per_h,
       carbs_target_max_g_per_h    = EXCLUDED.carbs_target_max_g_per_h,
       intake_logged               = EXCLUDED.intake_logged,
       fluid_intake_l              = EXCLUDED.fluid_intake_l,
       net_fluid_l                 = EXCLUDED.net_fluid_l,
       body_mass_loss_pct          = EXCLUDED.body_mass_loss_pct,
       sodium_intake_mg            = EXCLUDED.sodium_intake_mg,
       net_sodium_mg               = EXCLUDED.net_sodium_mg,
       carbs_g                     = EXCLUDED.carbs_g,
       carbs_per_h                 = EXCLUDED.carbs_per_h,
       dehydrated                  = EXCLUDED.dehydrated,
       under_fueled                = EXCLUDED.under_fueled,
       computed_at                 = now()`,
    [
      row.id,
      row.durationS,
      row.avgHr,
      b.intensityMethod,
      b.intensityFactor,
      b.heatFactor,
      row.baselineSweatRateLPerH,
      row.sweatSodiumMgPerL,
      row.bodyMassKg,
      b.estSweatRateLPerH,
      b.estSweatLossL,
      b.estSodiumLossMg,
      b.carbTarget.minGPerH,
      b.carbTarget.maxGPerH,
      b.intakeLogged,
      b.fluidIntakeL,
      b.netFluidL,
      b.bodyMassLossPct,
      b.sodiumIntakeMg,
      b.netSodiumMg,
      b.carbsG,
      b.carbsPerH,
      b.dehydrated,
      b.underFueled,
    ],
  );
}

/** Model one candidate against the athlete's anchors + a baseline sweat rate. */
export function fuelingRowFor(
  c: FuelingCandidate,
  profile: Pick<
    AthleteProfile,
    'hrRest' | 'hrMax' | 'sweatSodiumMgPerL' | 'weightKgFallback'
  >,
  baselineSweatRateLPerH: number,
): FuelingBalanceRow {
  const bodyMassKg = c.bodyMassKg ?? profile.weightKgFallback;
  const balance = computeFuelingBalance({
    durationS: c.durationS,
    avgHr: c.avgHr,
    hrRest: profile.hrRest,
    hrMax: profile.hrMax,
    tempC: c.tempC,
    humidityPct: c.humidityPct,
    baselineSweatRateLPerH,
    sweatSodiumMgPerL: profile.sweatSodiumMgPerL,
    bodyMassKg,
    intake: c.intake,
  });
  return {
    id: c.id,
    durationS: c.durationS,
    avgHr: c.avgHr,
    baselineSweatRateLPerH,
    sweatSodiumMgPerL: profile.sweatSodiumMgPerL,
    bodyMassKg,
    balance,
  };
}

/**
 * Redo one activity's balance after an edit (MZY-253). An activity that is no
 * longer a candidate (trimmed under 60 min, no logged intake) loses its row.
 */
export async function recomputeFuelingBalance(
  activity: FuelingActivity,
  id: string,
  profile: Parameters<typeof fuelingRowFor>[1],
): Promise<FuelingBalanceRow | null> {
  const [c] = await loadFuelingCandidates(activity, [id]);
  if (!c) {
    const t = TABLES[activity];
    await query(`DELETE FROM ${t.balance} WHERE ${t.fk} = $1`, [id]);
    return null;
  }
  const row = fuelingRowFor(c, profile, await getBaselineSweatRate());
  await upsertFuelingBalance(activity, row);
  return row;
}

import { query } from './db';

// Storage for all-day physical-activity totals (steps, floors, active minutes,
// calories, resting HR). Source-agnostic; Fitbit writes it today, Google Health
// takes over before the Fitbit Web API sunsets Sept 2026 (Workstream C).

export type DailyActivitySource = 'fitbit' | 'manual' | 'google_health';

export interface DailyActivityRecord {
  date: string; // YYYY-MM-DD
  source: DailyActivitySource;
  steps: number | null;
  distanceKm: number | null;
  floors: number | null;
  activeMinutes: number | null;
  sedentaryMinutes: number | null;
  caloriesOut: number | null;
  restingHr: number | null;
}

/** Upsert a day's activity totals (idempotent on date+source). */
export async function upsertDailyActivity(
  r: DailyActivityRecord,
): Promise<void> {
  await query(
    `INSERT INTO public.daily_activity
       (date, source, steps, distance_km, floors, active_minutes,
        sedentary_minutes, calories_out, resting_hr)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (date, source) DO UPDATE SET
       steps             = EXCLUDED.steps,
       distance_km       = EXCLUDED.distance_km,
       floors            = EXCLUDED.floors,
       active_minutes    = EXCLUDED.active_minutes,
       sedentary_minutes = EXCLUDED.sedentary_minutes,
       calories_out      = EXCLUDED.calories_out,
       resting_hr        = EXCLUDED.resting_hr`,
    [
      r.date,
      r.source,
      r.steps,
      r.distanceKm,
      r.floors,
      r.activeMinutes,
      r.sedentaryMinutes,
      r.caloriesOut,
      r.restingHr,
    ],
  );
}

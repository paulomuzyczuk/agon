import { query } from './db';

// Storage for recovery signals: sleep sessions and daily HRV. Source-agnostic;
// Fitbit writes them today, Google Health takes over before the Fitbit Web API
// sunsets Sept 2026 (Workstream C). Resting HR is not here — it lives in
// daily_activity.resting_hr (populated by the activity backfill).

export type WellnessSource = 'fitbit' | 'manual' | 'google_health';

export interface SleepSessionRecord {
  date: string; // YYYY-MM-DD (dateOfSleep)
  source: WellnessSource;
  // Idempotency key: (source, externalId). Fitbit sets externalId = String(logId)
  // (numeric) and keeps logId; Google Health's session id is an opaque string, so
  // it sets externalId and leaves logId null. See migration 20260724014000.
  externalId: string | null;
  logId: number | null;
  startAt: string | null; // ISO UTC
  endAt: string | null; // ISO UTC
  isMainSleep: boolean | null;
  minutesAsleep: number | null;
  minutesAwake: number | null;
  timeInBed: number | null;
  efficiency: number | null;
  deepMin: number | null;
  lightMin: number | null;
  remMin: number | null;
  wakeMin: number | null;
}

/** Upsert a sleep session (idempotent on source + external id). */
export async function upsertSleepSession(r: SleepSessionRecord): Promise<void> {
  await query(
    `INSERT INTO public.sleep_sessions
       (date, source, external_id, log_id, start_at, end_at, is_main_sleep,
        minutes_asleep, minutes_awake, time_in_bed, efficiency, deep_min,
        light_min, rem_min, wake_min)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (source, external_id) DO UPDATE SET
       date           = EXCLUDED.date,
       log_id         = EXCLUDED.log_id,
       start_at       = EXCLUDED.start_at,
       end_at         = EXCLUDED.end_at,
       is_main_sleep  = EXCLUDED.is_main_sleep,
       minutes_asleep = EXCLUDED.minutes_asleep,
       minutes_awake  = EXCLUDED.minutes_awake,
       time_in_bed    = EXCLUDED.time_in_bed,
       efficiency     = EXCLUDED.efficiency,
       deep_min       = EXCLUDED.deep_min,
       light_min      = EXCLUDED.light_min,
       rem_min        = EXCLUDED.rem_min,
       wake_min       = EXCLUDED.wake_min`,
    [
      r.date,
      r.source,
      r.externalId,
      r.logId,
      r.startAt,
      r.endAt,
      r.isMainSleep,
      r.minutesAsleep,
      r.minutesAwake,
      r.timeInBed,
      r.efficiency,
      r.deepMin,
      r.lightMin,
      r.remMin,
      r.wakeMin,
    ],
  );
}

export interface HrvDailyRecord {
  date: string;
  source: WellnessSource;
  dailyRmssd: number | null;
  deepRmssd: number | null;
}

/** Upsert a day's HRV (idempotent on date + source). */
export async function upsertHrvDaily(r: HrvDailyRecord): Promise<void> {
  await query(
    `INSERT INTO public.hrv_daily (date, source, daily_rmssd, deep_rmssd)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (date, source) DO UPDATE SET
       daily_rmssd = EXCLUDED.daily_rmssd,
       deep_rmssd  = EXCLUDED.deep_rmssd`,
    [r.date, r.source, r.dailyRmssd, r.deepRmssd],
  );
}

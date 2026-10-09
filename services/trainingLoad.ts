import { query } from './db';
import { computeTrainingLoad, type TrainingLoadDay } from '../lib/trainingLoad';

// DB access for the training-load backfill. The EWMA math is pure
// (lib/trainingLoad.ts); this module reads the daily Relative Effort sums and
// upserts the per-day CTL/ATL/TSB row. Orchestration lives in
// scripts/backfill-training-load.ts; recomputeTrainingLoadFrom refreshes the
// tail after one activity's score changed (MZY-253).

/** Persisted model parameters, stored alongside each row for auditability. */
export interface TrainingLoadParams {
  ctlDays: number;
  atlDays: number;
  tsbMode: 'prev-day' | 'same-day';
}

/** TrainingPeaks defaults; the model stores these so the numbers stay auditable. */
export const TRAINING_LOAD_PARAMS: TrainingLoadParams = {
  ctlDays: 42,
  atlDays: 7,
  tsbMode: 'prev-day',
};

/**
 * Daily training load = SUM of per-run Relative Effort + per-ride Relative
 * Effort, grouped by calendar date. Only days with at least one scored
 * run/ride appear here; the pure model fills the rest of the spine with 0.
 */
export async function loadDailyRelativeEffort(): Promise<
  { date: string; load: number }[]
> {
  const { rows } = await query<{ date: string; load: string }>(
    `SELECT date, SUM(score) AS load FROM (
       SELECT r.date::text AS date, rre.score AS score
         FROM public.run_relative_effort rre
         JOIN public.runs r ON r.id = rre.run_id
       UNION ALL
       SELECT rd.date::text AS date, ride_re.score AS score
         FROM public.ride_relative_effort ride_re
         JOIN public.rides rd ON rd.id = ride_re.ride_id
     ) daily_scores
      GROUP BY date
      ORDER BY date`,
  );
  return rows.map((r) => ({ date: r.date, load: Number(r.load) }));
}

/** Idempotent upsert of one day's CTL/ATL/TSB (date PK — recompute overwrites). */
export async function upsertTrainingLoadDay(
  day: TrainingLoadDay,
  params: TrainingLoadParams,
): Promise<void> {
  await query(
    `INSERT INTO public.training_load_daily
       (date, daily_load, ctl, atl, tsb, ctl_days, atl_days, tsb_mode, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (date) DO UPDATE SET
       daily_load = EXCLUDED.daily_load,
       ctl        = EXCLUDED.ctl,
       atl        = EXCLUDED.atl,
       tsb        = EXCLUDED.tsb,
       ctl_days   = EXCLUDED.ctl_days,
       atl_days   = EXCLUDED.atl_days,
       tsb_mode   = EXCLUDED.tsb_mode,
       computed_at = now()`,
    [
      day.date,
      day.load,
      day.ctl,
      day.atl,
      day.tsb,
      params.ctlDays,
      params.atlDays,
      params.tsbMode,
    ],
  );
}

/**
 * Recompute the load series and rewrite the days from `fromDate` through
 * `end` (default today, UTC). Earlier days can't change — the EWMAs only run
 * forward — so only the tail is written. No-op without any scored activity.
 */
export async function recomputeTrainingLoadFrom(
  fromDate: string,
  end: string = new Date().toISOString().slice(0, 10),
  params: TrainingLoadParams = TRAINING_LOAD_PARAMS,
): Promise<number> {
  const daily = await loadDailyRelativeEffort();
  if (daily.length === 0) return 0;
  const series = computeTrainingLoad(daily, { ...params, end });
  let written = 0;
  for (const day of series) {
    if (day.date < fromDate) continue;
    await upsertTrainingLoadDay(day, params);
    written++;
  }
  return written;
}

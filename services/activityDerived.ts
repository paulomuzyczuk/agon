import { getAthleteProfile } from '../lib/athleteProfile';
import { logger } from './logger';
import { recomputeRunRelativeEffort } from './relativeEffort';
import { recomputeRideRelativeEffort } from './relativeEffortRides';
import { recomputeRunBestEfforts } from './bestEfforts';
import { recomputeRidePowerMetrics } from './ridePowerMetrics';
import { recomputeFuelingBalance } from './fuelingBalance';
import { recomputeTrainingLoadFrom } from './trainingLoad';
import { refreshActivityWeather } from './weather/enrich';

// Refresh everything derived from one run/ride after a hand correction
// (MZY-253) — the single-activity counterparts of `pnpm re:backfill`,
// `re:backfill-rides`, `be:backfill`, `power:backfill-metrics`,
// `fueling:backfill` and `tl:backfill`, sharing their per-activity code.
// Order matters: weather first (the fueling model's heat factor reads it),
// Relative Effort before training load (the load sums it). Ride power metrics
// (NP/IF/TSS, MZY-269) are their own step and never feed the load.
//
// Best-effort: the correction is already committed, so a failing step is
// logged and reported, never thrown — the matching backfill fixes it later.
// The dbt marts (fct_*) refresh on the next `dbt build`.

export type DerivedStep =
  | 'weather'
  | 'relative_effort'
  | 'best_efforts'
  | 'power_metrics'
  | 'fueling_balance'
  | 'training_load';

export interface DerivedRecomputeResult {
  ok: DerivedStep[];
  failed: DerivedStep[];
}

export interface DerivedRecomputeOptions {
  /** started_at moved → re-fetch weather at the new start. */
  startMoved: boolean;
  /** Earliest date whose load may have changed (min of old/new date). */
  fromDate: string;
}

export async function recomputeDerivedForActivity(
  kind: 'run' | 'ride',
  id: string,
  opts: DerivedRecomputeOptions,
): Promise<DerivedRecomputeResult> {
  const profile = getAthleteProfile();
  const anchors = { hrRest: profile.hrRest, hrMax: profile.hrMax };
  const steps: Array<[DerivedStep, () => Promise<unknown>]> = [];
  // refreshActivityWeather swallows its own errors (post-sync-hook contract).
  if (opts.startMoved) {
    steps.push(['weather', () => refreshActivityWeather(kind, id)]);
  }
  steps.push([
    'relative_effort',
    () =>
      kind === 'run'
        ? recomputeRunRelativeEffort(id, anchors)
        : recomputeRideRelativeEffort(id, anchors),
  ]);
  if (kind === 'run') {
    steps.push(['best_efforts', () => recomputeRunBestEfforts(id)]);
  } else {
    // Device-measured watts only; a ride without a meter stream gets no row.
    steps.push([
      'power_metrics',
      () => recomputeRidePowerMetrics(id, profile.ftpHistory),
    ]);
  }
  steps.push([
    'fueling_balance',
    () => recomputeFuelingBalance(kind, id, profile),
  ]);
  steps.push(['training_load', () => recomputeTrainingLoadFrom(opts.fromDate)]);

  const result: DerivedRecomputeResult = { ok: [], failed: [] };
  for (const [step, fn] of steps) {
    try {
      await fn();
      result.ok.push(step);
    } catch (err) {
      result.failed.push(step);
      logger.warn('derived recompute after correction failed', {
        job: 'activity-correction',
        kind,
        id,
        step,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

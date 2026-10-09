import { readNumber, structuredDateToISO } from './wellnessMap';
import type { ActivityAccumulator, ActivityKey } from './wellnessMap';
import type { CivilDateTime, RollupDataPoint } from './types';

// Pure mapping for the `dailyRollUp` custom method — the correct daily-TOTAL
// source for steps/distance/floors/total-calories (List returns overlapping
// multi-source samples for these and can't be summed correctly; see
// wellnessMap.ts's ACTIVITY_METRICS comment). Split out of wellnessMap.ts to
// stay under the file-size budget; feeds the SAME ActivityAccumulator that
// module's foldActivityPoints fills, so a day's record ends up carrying
// active-zone-minutes/resting-HR (from List) alongside steps/distance/floors/
// calories (from here) once both passes run.

export interface RollupMetricSpec {
  /** kebab dataType id requested (POST .../dataTypes/{dataType}/dataPoints:dailyRollUp). */
  dataType: string;
  key: ActivityKey;
  /** camelCase union field on the response's RollupDataPoint. */
  field: 'steps' | 'distance' | 'floors' | 'totalCalories';
  /** the `*Sum` field inside that union member. */
  sumField: string;
  /** multiply the raw sum (e.g. metres → km). */
  scale: number;
  /** Google's max civil-date range per dailyRollUp call, in days. */
  maxRangeDays: number;
}

export const ROLLUP_METRICS: readonly RollupMetricSpec[] = [
  {
    dataType: 'steps',
    key: 'steps',
    field: 'steps',
    sumField: 'countSum',
    scale: 1,
    maxRangeDays: 90,
  },
  {
    dataType: 'distance',
    key: 'distanceKm',
    field: 'distance',
    // Live-verified 2026-08-26: the real field is `millimetersSum` (int64), NOT
    // the documented `metersSum` — a direct probe against the API confirmed it
    // (values like "17902309" mm = 17.9 km, matching a plausible long-run day).
    sumField: 'millimetersSum',
    scale: 0.000001,
    maxRangeDays: 90,
  },
  {
    dataType: 'floors',
    key: 'floors',
    field: 'floors',
    sumField: 'floorsSum',
    scale: 1,
    maxRangeDays: 90,
  },
  {
    dataType: 'total-calories',
    key: 'caloriesOut',
    field: 'totalCalories',
    sumField: 'kcalSum',
    scale: 1,
    // total-calories shares the 14-day cap Google documents for
    // calories-in-heart-rate-zone/heart-rate/active-minutes.
    maxRangeDays: 14,
  },
] as const;

/**
 * Fold one metric's rollupDataPoints into the accumulator (pure). Each point is
 * already a whole-day total (civilStartTime is the day; windowSizeDays=1), so
 * this SETS rather than sums — unlike foldActivityPoints, which sums discrete
 * sub-day intervals.
 */
export function foldRollupPoints(
  acc: ActivityAccumulator,
  spec: RollupMetricSpec,
  points: RollupDataPoint[],
): void {
  for (const dp of points) {
    const day = structuredDateToISO(dp.civilStartTime?.date);
    if (!day) continue;
    const valueObj = (dp as Record<string, unknown>)[spec.field];
    const raw = readNumber(
      valueObj && typeof valueObj === 'object'
        ? (valueObj as Record<string, unknown>)
        : null,
      [spec.sumField],
    );
    if (raw == null) continue;
    const bucket = acc.get(day) ?? {};
    bucket[spec.key] = raw * spec.scale;
    acc.set(day, bucket);
  }
}

/**
 * CivilDateTime for a local calendar day. NOTE: CivilDateTime deliberately
 * carries no timezone/offset field (verified live 2026-08-26 — a flat
 * {year,month,day,utcOffsetSeconds} 400s; year/month/day nest under `date`, and
 * there is no offset member at all). Google buckets by the ACCOUNT's own
 * registered civil timezone, not one we send — so this is only correct insofar
 * as that matches ATHLETE_TIME_ZONE (it does, live-verified against the
 * athlete's Berlin account).
 */
export function civilDateForLocalDay(localDay: string): CivilDateTime {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDay);
  if (!m) {
    throw new Error(`civilDateForLocalDay: invalid local day '${localDay}'`);
  }
  return {
    date: { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) },
  };
}

/** The dailyRollUp `range` (closed-open) for [sinceLocalDay, untilExclusiveLocalDay). */
export function rollupRangeFor(
  sinceLocalDay: string,
  untilExclusiveLocalDay: string,
): { start: CivilDateTime; end: CivilDateTime } {
  return {
    start: civilDateForLocalDay(sinceLocalDay),
    end: civilDateForLocalDay(untilExclusiveLocalDay),
  };
}

/**
 * Split [sinceLocalDay, untilExclusiveLocalDay) into chunks of at most `maxDays`
 * — dailyRollUp caps the civil-date range per call (14 or 90 days depending on
 * dataType), so a long backfill window must be split before calling it. Pure
 * date-string arithmetic (UTC-midnight boundaries); only used to bound the
 * NUMBER of chunks, not to compute the real civil dates (civilDateForLocalDay
 * does the DST-aware conversion for each boundary).
 */
export function chunkLocalDayRange(
  sinceLocalDay: string,
  untilExclusiveLocalDay: string,
  maxDays: number,
): Array<{ since: string; untilExclusive: string }> {
  const chunks: Array<{ since: string; untilExclusive: string }> = [];
  const endMs = Date.parse(`${untilExclusiveLocalDay}T00:00:00Z`);
  let cursor = sinceLocalDay;
  let cursorMs = Date.parse(`${cursor}T00:00:00Z`);
  while (cursorMs < endMs) {
    const nextMs = Math.min(cursorMs + maxDays * 86_400_000, endMs);
    const next = new Date(nextMs).toISOString().slice(0, 10);
    chunks.push({ since: cursor, untilExclusive: next });
    cursor = next;
    cursorMs = nextMs;
  }
  return chunks;
}

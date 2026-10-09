import { logger } from '../logger';
import { athleteLocalParts } from '../../lib/time';
import { getAthleteProfile } from '../../lib/athleteProfile';
import {
  upsertDailyActivity,
  type DailyActivityRecord,
} from '../dailyActivity';
import {
  upsertSleepSession,
  upsertHrvDaily,
  type SleepSessionRecord,
  type HrvDailyRecord,
} from '../wellness';
import {
  upsertSourcedBodyMetric,
  type SourcedBodyMetricRecord,
} from '../bodyMetrics';
import { getValidAccessToken } from './oauth';
import {
  listDataPointsPage,
  dailyRollUp,
  GoogleHealthRateLimitError,
  type ListDataPointsParams,
  type DailyRollUpParams,
} from './client';
import type {
  WellnessDataPoint,
  WellnessDataPointList,
  RollupDataPoint,
  DailyRollUpResponse,
} from './types';
import {
  ACTIVITY_METRICS,
  type ActivityAccumulator,
  foldActivityPoints,
  accumulatorToRecords,
  mapSleepSession,
  mapDailyHrv,
  rangeFilterFor,
  dailyRangeFilter,
} from './wellnessMap';
import {
  ROLLUP_METRICS,
  foldRollupPoints,
  rollupRangeFor,
  chunkLocalDayRange,
} from './rollupMap';
import {
  BODY_DATA_TYPES,
  mapBodyPoint,
  dedupeMirroredBodyPoints,
  type MappedBodyPoint,
} from './bodyMap';

// Google Health wellness ingestion (Workstream C — the Fitbit Web API sunsets
// Sept 2026). The four Fitbit passes move onto the SAME Google Health client the
// run adapter uses: all-day activity (steps/distance/floors/active-minutes/
// calories) + resting HR → daily_activity, sleep → sleep_sessions, HRV →
// hrv_daily. Run HR is NOT here — it already migrated as part of the run adapter
// (heartRate.ts attaches Fitbit-wrist HR to each google_health run).
//
// This file is the ORCHESTRATOR; the pure payload mapping + daily-activity
// assembly + filter builders live in ./wellnessMap, and the dailyRollUp-specific
// mapping (steps/distance/floors/calories) in ./rollupMap. UNLIKE the run
// adapter, the sleep/HRV shapes in ./wellnessMap are built against the
// DOCUMENTED v4 API only — the union-field names, value units, and sleep-stage
// vocabulary are TODO(live), pinned against real payloads exactly as
// Workstream A did (the rollup shapes in ./rollupMap ARE live-pinned).

// Re-export the pure surface so ./index and callers have one import site.
export * from './wellnessMap';
export * from './rollupMap';
export * from './bodyMap';

const TZ = getAthleteProfile().timeZone;
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGES_PER_TYPE = 50; // runaway backstop; a year of daily data is far under this

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ── Orchestrator ──────────────────────────────────────────────────────────────

export interface GoogleHealthWellnessOptions {
  since: string; // YYYY-MM-DD (inclusive, local)
  until?: string; // YYYY-MM-DD (inclusive, local); defaults to today (athlete-local)
  activity?: boolean; // steps/distance/floors/active-minutes/calories + resting HR
  sleep?: boolean;
  hrv?: boolean;
  body?: boolean; // weight + body-fat → body_metrics (MZY-216)
  pageDelayMs?: number;
}

export interface GoogleHealthWellnessSummary {
  activityDaysUpserted: number;
  sleepUpserted: number;
  hrvUpserted: number;
  bodyUpserted: number;
  rateLimited: boolean;
}

/** Seams so the orchestration is unit-testable with no DB and no network. */
export interface GoogleHealthWellnessDeps {
  getAccessToken: () => Promise<string>;
  listDataPoints: (
    accessToken: string,
    params: ListDataPointsParams,
  ) => Promise<WellnessDataPointList>;
  dailyRollUp: (
    accessToken: string,
    params: DailyRollUpParams,
  ) => Promise<DailyRollUpResponse>;
  upsertDailyActivity: (r: DailyActivityRecord) => Promise<void>;
  upsertSleepSession: (r: SleepSessionRecord) => Promise<void>;
  upsertHrvDaily: (r: HrvDailyRecord) => Promise<void>;
  upsertBodyMetric: (r: SourcedBodyMetricRecord) => Promise<void>;
}

const defaultDeps: GoogleHealthWellnessDeps = {
  getAccessToken: getValidAccessToken,
  listDataPoints: listDataPointsPage,
  dailyRollUp,
  upsertDailyActivity,
  upsertSleepSession,
  upsertHrvDaily,
  upsertBodyMetric: upsertSourcedBodyMetric,
};

/** Local-day bounds: since (inclusive) and the day after until (exclusive). */
function dayAfter(localDay: string): string {
  return new Date(Date.parse(`${localDay}T00:00:00Z`) + 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Page through one dataType, collecting all points (bounded). `filter` is
 * omitted (undefined) for session-kind types like `sleep`, which reject a
 * start_time restriction — the caller then buckets client-side.
 */
async function collectDataPoints(
  deps: GoogleHealthWellnessDeps,
  accessToken: string,
  dataType: string,
  filter: string | undefined,
  pageDelayMs: number,
): Promise<WellnessDataPoint[]> {
  const out: WellnessDataPoint[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await deps.listDataPoints(accessToken, {
      dataType,
      filter,
      pageSize: DEFAULT_PAGE_SIZE,
      pageToken,
    });
    out.push(...page.dataPoints);
    pageToken = page.nextPageToken;
    pages += 1;
    if (pageToken && pages < MAX_PAGES_PER_TYPE) await sleep(pageDelayMs);
  } while (pageToken && pages < MAX_PAGES_PER_TYPE);
  return out;
}

/**
 * Page through one dataType's dailyRollUp over one civil-date range (bounded).
 * Mirrors collectDataPoints; the response envelope differs (rollupDataPoints vs
 * dataPoints) so it's a separate loop.
 */
async function collectRollupPoints(
  deps: GoogleHealthWellnessDeps,
  accessToken: string,
  dataType: string,
  range: {
    start: DailyRollUpParams['range']['start'];
    end: DailyRollUpParams['range']['end'];
  },
  pageDelayMs: number,
): Promise<RollupDataPoint[]> {
  const out: RollupDataPoint[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await deps.dailyRollUp(accessToken, {
      dataType,
      range,
      pageToken,
    });
    out.push(...page.rollupDataPoints);
    pageToken = page.nextPageToken;
    pages += 1;
    if (pageToken && pages < MAX_PAGES_PER_TYPE) await sleep(pageDelayMs);
  } while (pageToken && pages < MAX_PAGES_PER_TYPE);
  return out;
}

/**
 * Backfill Google Health wellness data over a local date range. Each pass is
 * independent and resumable via idempotent upserts. Stops cleanly on HTTP 429
 * (surfacing `rateLimited`) rather than throwing, so the next run resumes.
 */
export async function backfillGoogleHealthWellness(
  opts: GoogleHealthWellnessOptions,
  deps: GoogleHealthWellnessDeps = defaultDeps,
): Promise<GoogleHealthWellnessSummary> {
  const activity = opts.activity ?? true;
  const doSleep = opts.sleep ?? true;
  const hrv = opts.hrv ?? true;
  const body = opts.body ?? true;
  const pageDelayMs = opts.pageDelayMs ?? 250;
  const until =
    opts.until ?? athleteLocalParts(new Date().toISOString(), TZ).date;
  const untilExclusive = dayAfter(until);

  const accessToken = await deps.getAccessToken();
  const summary: GoogleHealthWellnessSummary = {
    activityDaysUpserted: 0,
    sleepUpserted: 0,
    hrvUpserted: 0,
    bodyUpserted: 0,
    rateLimited: false,
  };

  try {
    if (activity) {
      const acc: ActivityAccumulator = new Map();
      for (const spec of ACTIVITY_METRICS) {
        const filter = rangeFilterFor(
          spec.dataType,
          spec.kind,
          opts.since,
          untilExclusive,
        );
        const points = await collectDataPoints(
          deps,
          accessToken,
          spec.dataType,
          filter,
          pageDelayMs,
        );
        foldActivityPoints(acc, spec, points);
      }
      for (const spec of ROLLUP_METRICS) {
        for (const chunk of chunkLocalDayRange(
          opts.since,
          untilExclusive,
          spec.maxRangeDays,
        )) {
          const range = rollupRangeFor(chunk.since, chunk.untilExclusive);
          const points = await collectRollupPoints(
            deps,
            accessToken,
            spec.dataType,
            range,
            pageDelayMs,
          );
          foldRollupPoints(acc, spec, points);
        }
      }
      for (const rec of accumulatorToRecords(acc)) {
        await deps.upsertDailyActivity(rec);
        summary.activityDaysUpserted += 1;
      }
    }

    if (doSleep) {
      // The `sleep` dataType (session-kind, like `exercise`) rejects a
      // start_time filter — Google returns 400 INVALID_DATA_POINT_FILTER
      // ("Restriction must have a member comparable. Found: VALUE"), the same
      // limitation the run adapter hit. So list unfiltered and bucket by local
      // wake-day client-side into [since, untilExclusive).
      const points = await collectDataPoints(
        deps,
        accessToken,
        'sleep',
        undefined,
        pageDelayMs,
      );
      for (const dp of points) {
        const rec = mapSleepSession(dp);
        if (!rec) continue;
        if (rec.date < opts.since || rec.date >= untilExclusive) continue;
        await deps.upsertSleepSession(rec);
        summary.sleepUpserted += 1;
      }
    }

    if (hrv) {
      const filter = dailyRangeFilter(
        'daily-heart-rate-variability',
        opts.since,
        untilExclusive,
      );
      const points = await collectDataPoints(
        deps,
        accessToken,
        'daily-heart-rate-variability',
        filter,
        pageDelayMs,
      );
      for (const dp of points) {
        const rec = mapDailyHrv(dp);
        if (rec) {
          await deps.upsertHrvDaily(rec);
          summary.hrvUpserted += 1;
        }
      }
    }

    if (body) {
      // Weigh-ins are sparse (a handful a month), so list unfiltered and bucket
      // by local day client-side, like sleep — avoids pinning an unverified
      // sample-kind filter grammar for two more dataTypes.
      const mapped: MappedBodyPoint[] = [];
      for (const dataType of BODY_DATA_TYPES) {
        const points = await collectDataPoints(
          deps,
          accessToken,
          dataType,
          undefined,
          pageDelayMs,
        );
        for (const dp of points) {
          const m = mapBodyPoint(dp, dataType);
          if (m) mapped.push(m);
        }
      }
      // Dedupe across the FULL history before the date-window cut, so which
      // mirrored copy is kept never depends on the requested range.
      for (const rec of dedupeMirroredBodyPoints(mapped)) {
        if (rec.date < opts.since || rec.date >= untilExclusive) continue;
        await deps.upsertBodyMetric(rec);
        summary.bodyUpserted += 1;
      }
    }
  } catch (err) {
    if (err instanceof GoogleHealthRateLimitError) {
      summary.rateLimited = true;
      logger.warn(
        'google-health wellness backfill stopped on rate limit — resume later',
        { job: 'google-health-wellness', ...summary },
      );
      return summary;
    }
    throw err;
  }

  logger.info('google-health wellness backfill complete', {
    job: 'google-health-wellness',
    ...summary,
  });
  return summary;
}

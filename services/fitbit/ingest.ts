import { query } from '../db';
import { logger } from '../logger';
import { athleteLocalParts } from '../../lib/time';
import { getAthleteProfile } from '../../lib/athleteProfile';
import { upsertDailyActivity } from '../dailyActivity';
import { hasRunStreams, upsertRunStreams } from '../runStreams';
import { upsertSleepSession, upsertHrvDaily } from '../wellness';
import { getValidAccessToken } from './oauth';
import {
  getDailyActivitySummary,
  getIntradayHeartRate,
  getSleepLogs,
  getHrv,
  FitbitRateLimitError,
} from './client';
import {
  summaryToDailyActivity,
  intradayToRunStream,
  sleepLogToRecord,
  hrvToRecord,
} from './mapper';

// ⚠️ DEPRECATED 2026-07-24 (Workstream C — see services/fitbit/index.ts). Migrated
// onto the Google Health API (`pnpm gh:wellness` + the run adapter's HR attach)
// before the Fitbit Web API sunsets Sept 2026. Kept as a cutover fallback.
//
// Fitbit physical-activity backfill: all-day step/activity totals, and each
// run's granular HR curve. The run-HR pass is driven off OUR runs — for every
// run with a start instant we ask Fitbit "what was my HR during this window" —
// so no fragile activity-to-run matching is needed. Both passes are idempotent
// and resumable, and stop cleanly on a 429.

const DAY_MS = 86_400_000;
const TZ = getAthleteProfile().timeZone;

export interface FitbitBackfillOptions {
  steps?: boolean;
  runHr?: boolean;
  sleep?: boolean;
  hrv?: boolean;
  since: string; // YYYY-MM-DD (inclusive)
  until?: string; // YYYY-MM-DD (inclusive); defaults to today (athlete-local)
}

export interface FitbitBackfillSummary {
  daysUpserted: number;
  runStreamsFetched: number;
  sleepUpserted: number;
  hrvUpserted: number;
  rateLimited: boolean;
}

// Sleep + HRV range endpoints return many days per call; chunk to stay well
// under Fitbit's ~100-record response cap.
const RANGE_CHUNK_DAYS = 30;

function dateChunks(
  since: string,
  until: string,
): Array<{ start: string; end: string }> {
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`fitbit backfill: invalid date range ${since}..${until}`);
  }
  const out: Array<{ start: string; end: string }> = [];
  for (let t = start; t <= end; t += RANGE_CHUNK_DAYS * DAY_MS) {
    const chunkEnd = Math.min(t + (RANGE_CHUNK_DAYS - 1) * DAY_MS, end);
    out.push({
      start: new Date(t).toISOString().slice(0, 10),
      end: new Date(chunkEnd).toISOString().slice(0, 10),
    });
  }
  return out;
}

function eachDate(since: string, until: string): string[] {
  const start = Date.parse(`${since}T00:00:00Z`);
  const end = Date.parse(`${until}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`fitbit backfill: invalid date range ${since}..${until}`);
  }
  const out: string[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function secondsToHHmm(sec: number): string {
  const clamped = Math.min(Math.max(sec, 0), 86_399);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function backfillDailyActivity(
  accessToken: string,
  since: string,
  until: string,
  summary: FitbitBackfillSummary,
): Promise<void> {
  for (const date of eachDate(since, until)) {
    const daySummary = await getDailyActivitySummary(accessToken, date);
    await upsertDailyActivity(summaryToDailyActivity(date, daySummary));
    summary.daysUpserted++;
  }
}

async function backfillRunHeartRate(
  accessToken: string,
  since: string,
  summary: FitbitBackfillSummary,
): Promise<void> {
  const { rows } = await query<{
    id: string;
    started_at: Date;
    duration_s: number;
  }>(
    `SELECT id, started_at, duration_s
       FROM public.runs
      WHERE started_at IS NOT NULL AND started_at >= $1
      ORDER BY started_at`,
    [`${since}T00:00:00Z`],
  );

  for (const run of rows) {
    if (await hasRunStreams(run.id, 'fitbit')) continue; // resumable

    const local = athleteLocalParts(run.started_at.toISOString(), TZ);
    const startHHmm = secondsToHHmm(local.secondsOfDay);
    const endHHmm = secondsToHHmm(local.secondsOfDay + run.duration_s);

    const dataset = await getIntradayHeartRate(
      accessToken,
      local.date,
      startHHmm,
      endHHmm,
    );
    if (dataset.length === 0) continue; // no wrist HR for this window

    const stream = intradayToRunStream(local.secondsOfDay, dataset);
    if (stream.timeS.length === 0) continue;
    await upsertRunStreams(run.id, 'fitbit', stream);
    summary.runStreamsFetched++;
  }
}

async function backfillSleep(
  accessToken: string,
  since: string,
  until: string,
  summary: FitbitBackfillSummary,
): Promise<void> {
  for (const chunk of dateChunks(since, until)) {
    const logs = await getSleepLogs(accessToken, chunk.start, chunk.end);
    for (const log of logs) {
      await upsertSleepSession(sleepLogToRecord(log, TZ));
      summary.sleepUpserted++;
    }
  }
}

async function backfillHrv(
  accessToken: string,
  since: string,
  until: string,
  summary: FitbitBackfillSummary,
): Promise<void> {
  for (const chunk of dateChunks(since, until)) {
    const entries = await getHrv(accessToken, chunk.start, chunk.end);
    for (const entry of entries) {
      await upsertHrvDaily(hrvToRecord(entry));
      summary.hrvUpserted++;
    }
  }
}

export async function backfillFitbit(
  opts: FitbitBackfillOptions,
): Promise<FitbitBackfillSummary> {
  const steps = opts.steps ?? true;
  const runHr = opts.runHr ?? true;
  const sleep = opts.sleep ?? true;
  const hrv = opts.hrv ?? true;
  const until =
    opts.until ?? athleteLocalParts(new Date().toISOString(), TZ).date;

  const accessToken = await getValidAccessToken();
  const summary: FitbitBackfillSummary = {
    daysUpserted: 0,
    runStreamsFetched: 0,
    sleepUpserted: 0,
    hrvUpserted: 0,
    rateLimited: false,
  };

  try {
    if (steps) {
      await backfillDailyActivity(accessToken, opts.since, until, summary);
    }
    if (runHr) {
      await backfillRunHeartRate(accessToken, opts.since, summary);
    }
    if (sleep) {
      await backfillSleep(accessToken, opts.since, until, summary);
    }
    if (hrv) {
      await backfillHrv(accessToken, opts.since, until, summary);
    }
  } catch (err) {
    if (err instanceof FitbitRateLimitError) {
      summary.rateLimited = true;
      logger.warn('fitbit backfill stopped on rate limit — resume later', {
        job: 'fitbit-backfill',
        ...summary,
      });
      return summary;
    }
    throw err;
  }

  logger.info('fitbit backfill complete', {
    job: 'fitbit-backfill',
    ...summary,
  });
  return summary;
}

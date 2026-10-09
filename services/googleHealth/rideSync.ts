import { query } from '../db';
import { logger } from '../logger';
import { DATA_SOURCES } from '../../lib/constants';
import {
  backfillGoogleHealthRides,
  type GoogleHealthRideBackfillOptions,
  type GoogleHealthRideBackfillSummary,
} from './rideIngest';

// Incremental Google Health ride sync — mirrors services/googleHealth/sync.ts
// (the run sync) exactly, including its client-side watermark design.

export interface GoogleHealthRideSyncSummary extends GoogleHealthRideBackfillSummary {
  since: string | null;
}

export interface GoogleHealthRideSyncOptions {
  withStreams?: boolean;
  maxPages?: number;
  pageDelayMs?: number;
  pageSize?: number;
}

export interface GoogleHealthRideSyncDeps {
  getWatermark: () => Promise<Date | null>;
  runIncremental: (
    opts: GoogleHealthRideBackfillOptions,
  ) => Promise<GoogleHealthRideBackfillSummary>;
}

export async function getGoogleHealthRideWatermark(): Promise<Date | null> {
  const { rows } = await query<{ latest: Date | null }>(
    `SELECT max(started_at) AS latest FROM public.rides WHERE source = $1`,
    [DATA_SOURCES.GOOGLE_HEALTH],
  );
  return rows[0]?.latest ?? null;
}

export function startTimeAfterFromWatermark(
  watermark: Date | null,
): string | undefined {
  return watermark == null ? undefined : watermark.toISOString();
}

const defaultDeps: GoogleHealthRideSyncDeps = {
  getWatermark: getGoogleHealthRideWatermark,
  runIncremental: backfillGoogleHealthRides,
};

export async function syncNewGoogleHealthRides(
  opts: GoogleHealthRideSyncOptions = {},
  deps: GoogleHealthRideSyncDeps = defaultDeps,
): Promise<GoogleHealthRideSyncSummary> {
  const watermark = await deps.getWatermark();
  const startTimeAfter = startTimeAfterFromWatermark(watermark);

  logger.info('starting google-health ride incremental sync', {
    job: 'google-health-ride-sync',
    since: startTimeAfter ?? null,
  });

  const summary = await deps.runIncremental({
    startTimeAfter,
    withStreams: opts.withStreams ?? true,
    maxPages: opts.maxPages,
    pageDelayMs: opts.pageDelayMs,
    pageSize: opts.pageSize,
  });

  const result: GoogleHealthRideSyncSummary = {
    ...summary,
    since: startTimeAfter ?? null,
  };
  logger.info('google-health ride incremental sync complete', {
    job: 'google-health-ride-sync',
    ...result,
  });
  return result;
}

/** One-line human summary of a sync, shared by the CLI script. */
export function describeGoogleHealthRideSyncSummary(
  s: GoogleHealthRideSyncSummary,
): string {
  const n = s.ridesInserted;
  const noun = n === 1 ? 'ride' : 'rides';
  if (s.rateLimited) {
    return `Pulled ${n} new ${noun} before hitting Google Health's rate limit — sync again shortly to resume.`;
  }
  return `Pulled ${n} new ${noun}.`;
}

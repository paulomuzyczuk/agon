import { query } from '../db';
import { logger } from '../logger';
import { DATA_SOURCES } from '../../lib/constants';
import {
  backfillHistoricalRides,
  type RideBackfillOptions,
  type RideBackfillSummary,
} from './rideIngest';

// Incremental Strava ride sync — mirrors services/strava/sync.ts (the run
// sync) exactly, including its watermark design. Strava plays a secondary
// (historical backfill / one-time enrichment) role here, same as it now does
// for runs — Google Health is the live source for rides.

export interface RideSyncSummary extends RideBackfillSummary {
  since: number | null;
}

export interface RideSyncOptions {
  withStreams?: boolean;
  resolveGear?: boolean;
  maxPages?: number;
  pageDelayMs?: number;
}

export interface RideSyncDeps {
  getWatermark: () => Promise<Date | null>;
  runIncremental: (opts: RideBackfillOptions) => Promise<RideBackfillSummary>;
}

export async function getStravaRideWatermark(): Promise<Date | null> {
  const { rows } = await query<{ latest: Date | null }>(
    `SELECT max(started_at) AS latest FROM public.rides WHERE source = $1`,
    [DATA_SOURCES.STRAVA],
  );
  return rows[0]?.latest ?? null;
}

export function afterEpochFromWatermark(
  watermark: Date | null,
): number | undefined {
  if (watermark == null) return undefined;
  return Math.floor(watermark.getTime() / 1000);
}

const defaultDeps: RideSyncDeps = {
  getWatermark: getStravaRideWatermark,
  runIncremental: backfillHistoricalRides,
};

export async function syncNewStravaRides(
  opts: RideSyncOptions = {},
  deps: RideSyncDeps = defaultDeps,
): Promise<RideSyncSummary> {
  const watermark = await deps.getWatermark();
  const after = afterEpochFromWatermark(watermark);

  logger.info('starting strava ride incremental sync', {
    job: 'strava-ride-sync',
    since: after ?? null,
  });

  const summary = await deps.runIncremental({
    after,
    withStreams: opts.withStreams ?? true,
    resolveGear: opts.resolveGear ?? true,
    maxPages: opts.maxPages,
    pageDelayMs: opts.pageDelayMs,
  });

  const result: RideSyncSummary = { ...summary, since: after ?? null };
  logger.info('strava ride incremental sync complete', {
    job: 'strava-ride-sync',
    ...result,
  });
  return result;
}

/** One-line human summary of a sync, shared by the CLI script. */
export function describeRideSyncSummary(s: RideSyncSummary): string {
  const n = s.ridesInserted;
  const noun = n === 1 ? 'ride' : 'rides';
  if (s.rateLimited) {
    return `Pulled ${n} new ${noun} before hitting Strava's rate limit — sync again shortly to resume.`;
  }
  return `Pulled ${n} new ${noun}.`;
}

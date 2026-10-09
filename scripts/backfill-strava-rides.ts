import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { backfillHistoricalRides } from '../services/strava/rideIngest';
import { logger } from '../services/logger';

// Historical Strava → public.rides backfill. Mirrors scripts/backfill-strava.ts
// (the run backfill) — see that file for the fuller comment. Idempotent: safe
// to re-run; existing rides are updated in place and later enrichment is
// preserved (see services/strava/rideIngest.ts upsertRide).
//
//   pnpm strava:backfill-rides                      full history
//   pnpm strava:backfill-rides --after=2026-03-23    only activities on/after a date
//   pnpm strava:backfill-rides --no-gear             skip bike-name resolution
//   pnpm strava:backfill-rides --no-streams   skip each ride's full time-series pull (lighter)
//
// This is a REAL ingestion job — it deliberately does NOT use the seed guard.

function epochFromDateArg(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(
      `backfill-strava-rides: invalid date '${value}' (use YYYY-MM-DD)`,
    );
  }
  return Math.floor(ms / 1000);
}

function parseArgs(argv: string[]): {
  after?: number;
  before?: number;
  resolveGear: boolean;
  withStreams: boolean;
} {
  let after: number | undefined;
  let before: number | undefined;
  let resolveGear = true;
  let withStreams = true;
  for (const arg of argv) {
    if (arg === '--no-gear') resolveGear = false;
    else if (arg === '--no-streams') withStreams = false;
    else if (arg.startsWith('--after=')) after = epochFromDateArg(arg.slice(8));
    else if (arg.startsWith('--before='))
      before = epochFromDateArg(arg.slice(9));
  }
  return { after, before, resolveGear, withStreams };
}

async function main(): Promise<void> {
  loadEnv();
  const { after, before, resolveGear, withStreams } = parseArgs(
    process.argv.slice(2),
  );

  logger.info('starting strava ride backfill', {
    job: 'strava-ride-backfill',
    after,
    before,
    resolveGear,
    withStreams,
  });

  const summary = await backfillHistoricalRides({
    after,
    before,
    resolveGear,
    withStreams,
  });

  // eslint-disable-next-line no-console
  console.log(
    `\nBackfill: ${summary.ridesInserted} inserted, ${summary.ridesUpdated} updated, ` +
      `${summary.skippedNonRide} non-rides skipped, ${summary.pagesFetched} pages` +
      `${withStreams ? `, ${summary.streamsFetched} streams` : ''}` +
      `${summary.rateLimited ? ' (STOPPED on rate limit — re-run to resume)' : ''}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error(
      'strava ride backfill failed',
      { job: 'strava-ride-backfill' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

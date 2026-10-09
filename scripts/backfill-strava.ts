import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { backfillHistoricalRuns } from '../services/strava/ingest';
import { logger } from '../services/logger';

// Historical Strava → public.runs backfill (Phase 1 plumbing). Idempotent: safe
// to re-run; existing runs are updated in place and later enrichment is
// preserved (see services/strava/ingest.ts upsertRun).
//
//   pnpm strava:backfill                  full history (runs + avg/max HR + gear)
//   pnpm strava:backfill --after=2026-03-23   only activities on/after a date
//   pnpm strava:backfill --no-gear        skip shoe-name resolution (fewer API calls)
//   pnpm strava:backfill --no-streams   skip each run's full time-series pull (lighter)
//                                         (1 extra call/run — heavier; resumable)
//
// This is a REAL ingestion job — it deliberately does NOT use the seed guard, so
// it can legitimately target the production database via DATABASE_URL.

function epochFromDateArg(value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(
      `backfill-strava: invalid date '${value}' (use YYYY-MM-DD)`,
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

  logger.info('starting strava backfill', {
    job: 'strava-backfill',
    after,
    before,
    resolveGear,
    withStreams,
  });

  const summary = await backfillHistoricalRuns({
    after,
    before,
    resolveGear,
    withStreams,
  });

  // eslint-disable-next-line no-console
  console.log(
    `\nBackfill: ${summary.runsInserted} inserted, ${summary.runsUpdated} updated, ` +
      `${summary.skippedNonRun} non-runs skipped, ${summary.pagesFetched} pages` +
      `${withStreams ? `, ${summary.streamsFetched} streams` : ''}` +
      `${summary.rateLimited ? ' (STOPPED on rate limit — re-run to resume)' : ''}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('strava backfill failed', { job: 'strava-backfill' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

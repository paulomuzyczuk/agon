import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  syncNewGoogleHealthRuns,
  describeGoogleHealthSyncSummary,
} from '../services/googleHealth/sync';
import {
  syncNewGoogleHealthRides,
  describeGoogleHealthRideSyncSummary,
} from '../services/googleHealth/rideSync';
import { logger } from '../services/logger';
import { enrichMissingWeather } from '../services/weather/enrich';
import { postSyncMissedStops } from '../services/missedStops';

// Incremental Google Health → public.runs sync (Phase 1 plumbing; the forward run
// path after the Strava pivot — see docs/run-ingestion-migration.md and the Run
// Ingestion Pivot in CLAUDE.md). Pulls only the runs that landed since the newest
// google_health run already in the DB (the watermark), so new activities flow in
// automatically without re-paging history. Idempotent and rate-limit-aware; safe
// to run on a loop or a schedule.
//
//   pnpm gh:sync              pull new runs since the watermark (+ TCX HR/route)
//   pnpm gh:sync --no-streams skip the per-run TCX pull (lighter; no GPS/HR series)
//
// Like the Strava jobs, it deliberately does NOT use the seed guard, so it can
// legitimately target the production database via DATABASE_URL. It needs Google
// OAuth tokens — run `pnpm gh:auth` once to authorize.

function parseArgs(argv: string[]): { withStreams: boolean } {
  let withStreams = true;
  for (const arg of argv) {
    if (arg === '--no-streams') withStreams = false;
  }
  return { withStreams };
}

async function main(): Promise<void> {
  loadEnv();
  const { withStreams } = parseArgs(process.argv.slice(2));

  logger.info('starting google-health sync', {
    job: 'google-health-sync',
    withStreams,
  });

  const summary = await syncNewGoogleHealthRuns({ withStreams });

  // eslint-disable-next-line no-console
  console.log(
    `\n${describeGoogleHealthSyncSummary(summary)} ` +
      `(${summary.runsUpdated} existing updated, ${summary.runsDeduped} duplicate(s) collapsed, ` +
      `${summary.pagesFetched} pages` +
      `${withStreams ? `, ${summary.streamsFetched} route stream(s), ${summary.hrStreamsFetched} HR stream(s)` : ''}` +
      `${summary.since == null ? ', full pull — no prior Google Health runs' : ''}).\n`,
  );

  // Bike rides — same exercise-session pull, just bucketed differently
  // client-side (the API call itself is unfiltered by activity type; see
  // services/googleHealth/rideIngest.ts). A separate pass rather than a
  // single-pass split: simpler to review/resume independently, at the cost of
  // one extra paged API pull.
  const rideSummary = await syncNewGoogleHealthRides({ withStreams });

  // eslint-disable-next-line no-console
  console.log(
    `${describeGoogleHealthRideSyncSummary(rideSummary)} ` +
      `(${rideSummary.ridesUpdated} existing updated, ${rideSummary.ridesDeduped} duplicate(s) collapsed, ` +
      `${rideSummary.pagesFetched} pages` +
      `${withStreams ? `, ${rideSummary.streamsFetched} route stream(s), ${rideSummary.hrStreamsFetched} HR stream(s)` : ''}` +
      `${rideSummary.since == null ? ', full pull — no prior Google Health rides' : ''}).\n`,
  );

  // Weather for whatever just landed (MZY-226) — best-effort, never fails the sync.
  await enrichMissingWeather();
  // Missed-stop suggestions + Telegram nudge (MZY-254) — best-effort too.
  await postSyncMissedStops();
}

main()
  .catch((err) => {
    logger.error(
      'google-health sync failed',
      { job: 'google-health-sync' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  syncNewStravaRides,
  describeRideSyncSummary,
} from '../services/strava/rideSync';
import { logger } from '../services/logger';
import { enrichMissingWeather } from '../services/weather/enrich';
import { postSyncMissedStops } from '../services/missedStops';

// Incremental Strava → public.rides sync. Mirrors scripts/sync-strava.ts (the
// run sync). Strava plays a secondary (historical backfill / one-time
// enrichment) role for rides — same as it now does for runs — Google Health
// (pnpm gh:sync) is the live source.
//
//   pnpm strava:sync-rides              pull new rides since the watermark (+ full streams)
//   pnpm strava:sync-rides --no-streams skip the per-ride time-series pull
//   pnpm strava:sync-rides --no-gear    skip bike-name resolution
//
// Needs Strava OAuth tokens (run `pnpm strava:auth` once to authorize).

function parseArgs(argv: string[]): {
  withStreams: boolean;
  resolveGear: boolean;
} {
  let withStreams = true;
  let resolveGear = true;
  for (const arg of argv) {
    if (arg === '--no-streams') withStreams = false;
    else if (arg === '--no-gear') resolveGear = false;
  }
  return { withStreams, resolveGear };
}

async function main(): Promise<void> {
  loadEnv();
  const { withStreams, resolveGear } = parseArgs(process.argv.slice(2));

  logger.info('starting strava ride sync', {
    job: 'strava-ride-sync',
    withStreams,
    resolveGear,
  });

  const summary = await syncNewStravaRides({ withStreams, resolveGear });

  // eslint-disable-next-line no-console
  console.log(
    `\n${describeRideSyncSummary(summary)} ` +
      `(${summary.ridesUpdated} existing updated, ${summary.pagesFetched} pages` +
      `${withStreams ? `, ${summary.streamsFetched} streams` : ''}` +
      `${summary.since == null ? ', full pull — no prior Strava rides' : ''}).\n`,
  );

  // Weather for whatever just landed (MZY-226) — best-effort, never fails the sync.
  await enrichMissingWeather();
  // Missed-stop suggestions + Telegram nudge (MZY-254) — best-effort too.
  await postSyncMissedStops();
}

main()
  .catch((err) => {
    logger.error('strava ride sync failed', { job: 'strava-ride-sync' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

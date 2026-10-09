import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  syncNewStravaRuns,
  describeSyncSummary,
} from '../services/strava/sync';
import { logger } from '../services/logger';
import { enrichMissingWeather } from '../services/weather/enrich';
import { postSyncMissedStops } from '../services/missedStops';

// ⚠️ DEPRECATED 2026-07-24 — Strava retired as the live source (its API now
// needs a paid Strava subscription). Kept runnable for anyone who still has
// Strava access, but the forward path is the Google Health adapter; see
// docs/run-ingestion-migration.md and the Run Ingestion Pivot in CLAUDE.md.
//
// Incremental Strava → public.runs sync (Phase 1 plumbing). Pulls only the runs
// that landed since the newest Strava run already in the DB (the watermark), so
// new activities flow in automatically without re-paging history. Idempotent and
// rate-limit-aware; safe to run on a loop or a schedule.
//
//   pnpm strava:sync              pull new runs since the watermark (+ full streams)
//   pnpm strava:sync --no-streams skip the per-run time-series pull (lighter)
//   pnpm strava:sync --no-gear    skip shoe-name resolution (fewer API calls)
//
// The always-on / scheduled deploy is a later step — this is the clean one-shot
// entry point. Like the backfill, it deliberately does NOT use the seed guard, so
// it can legitimately target the production database via DATABASE_URL.
//
// This is a REAL ingestion job, not a test path — it needs Strava OAuth tokens
// (run `pnpm strava:auth` once to authorize).

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

  logger.info('starting strava sync', {
    job: 'strava-sync',
    withStreams,
    resolveGear,
  });

  const summary = await syncNewStravaRuns({ withStreams, resolveGear });

  // eslint-disable-next-line no-console
  console.log(
    `\n${describeSyncSummary(summary)} ` +
      `(${summary.runsUpdated} existing updated, ` +
      `${summary.runsSuperseded} Google Health twin(s) superseded, ` +
      `${summary.runsSkippedExisting} skipped for a higher-priority twin, ` +
      `${summary.pagesFetched} pages` +
      `${withStreams ? `, ${summary.streamsFetched} streams` : ''}` +
      `${summary.since == null ? ', full pull — no prior Strava runs' : ''}).\n`,
  );

  // Weather for whatever just landed (MZY-226) — best-effort, never fails the sync.
  await enrichMissingWeather();
  // Missed-stop suggestions + Telegram nudge (MZY-254) — best-effort too.
  await postSyncMissedStops();
}

main()
  .catch((err) => {
    logger.error('strava sync failed', { job: 'strava-sync' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

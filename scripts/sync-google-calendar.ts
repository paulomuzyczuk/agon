import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  syncTrainingCalendar,
  describeCalendarSyncSummary,
} from '../services/googleCalendar';
import { logger } from '../services/logger';

// Push planned training sessions to the dedicated "Agon Training" Google Calendar
// (and ensure the empty "Agon Meals" calendar exists). Idempotent — re-running
// updates existing events instead of duplicating. Requires `pnpm gcal:auth` first.
//
//   pnpm gcal:sync                 # future sessions only (today →)
//   pnpm gcal:sync --from=2026-03-23   # sync from a specific date (e.g. whole program)
//   pnpm gcal:sync --no-routes         # skip generating/attaching route links
//   pnpm gcal:sync --reconcile         # read the athlete's calendar edits back FIRST
//
// --reconcile runs `gcal:reconcile` before pushing, so an event moved or deleted
// by hand updates Agon instead of being overwritten by it. Opt-in because it
// WRITES (a move becomes a session_adjustments override, a deletion marks the
// session skipped); without it the push still silently wins, so prefer it on any
// calendar the athlete edits directly.
//
// By default each run event gets a suggested loop from home (Premium-Parity #6):
// a clickable Google Maps walking link in the description. Already-attached routes
// are reused, so re-syncing doesn't re-hit the routing API. Needs ORS_API_KEY +
// AGON_HOME_LAT/LNG; if a route can't be generated the event still syncs (no link).

function parseFrom(): string | undefined {
  const arg = process.argv.find((a) => a.startsWith('--from='));
  return arg ? arg.slice('--from='.length) : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const fromISO = parseFrom();
  const routes = !process.argv.includes('--no-routes');
  const reconcile = process.argv.includes('--reconcile');
  // Generating a diverse pool + place descriptions per run makes many ORS calls;
  // pace them under the free-tier ~40/min limit (unless the user set their own).
  if (routes && !process.env.ORS_MIN_INTERVAL_MS) {
    process.env.ORS_MIN_INTERVAL_MS = '1700';
  }
  const summary = await syncTrainingCalendar({
    ...(fromISO ? { fromISO } : {}),
    routes,
    reconcile,
  });
  logger.info('gcal:sync complete', {
    job: 'google-calendar-sync',
    ...summary,
  });
  // eslint-disable-next-line no-console
  console.log(`\n${describeCalendarSyncSummary(summary)}\n`);
}

main()
  .catch((err) => {
    logger.error(
      'sync-google-calendar failed',
      {
        job: 'google-calendar-sync',
      },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

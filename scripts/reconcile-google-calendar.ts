import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  reconcileFromCalendar,
  describeReconcileSummary,
} from '../services/googleCalendar/reconcile';
import { logger } from '../services/logger';

// Pull the athlete's own calendar edits back into Agon: a moved event becomes a
// session_adjustments override, a deleted event marks the session skipped. The
// program itself is never touched.
//
// Run it BEFORE gcal:sync — otherwise the sync pushes Agon's stale view back over
// the athlete's edit, which is the exact failure this pass exists to end.
//
//   pnpm gcal:reconcile                 DRY RUN from today (no writes)
//   pnpm gcal:reconcile --write
//   pnpm gcal:reconcile --from=2026-08-01 --write

function argVal(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(`--${name}=`.length) : undefined;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  loadEnv();
  const dryRun = !process.argv.includes('--write');
  const fromISO = argVal('from') ?? todayISO();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromISO)) {
    throw new Error(`invalid --from '${fromISO}' (use YYYY-MM-DD)`);
  }

  const summary = await reconcileFromCalendar({ fromISO, dryRun });
  // eslint-disable-next-line no-console
  console.log(`\n${describeReconcileSummary(summary, dryRun)}`);
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log('(dry run — pass --write to apply)\n');
  }
}

main()
  .catch((err) => {
    logger.error(
      'gcal:reconcile failed',
      { job: 'google-calendar-reconcile' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

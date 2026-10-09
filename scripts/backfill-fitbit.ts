import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { backfillFitbit } from '../services/fitbit/ingest';
import { logger } from '../services/logger';

// ⚠️ DEPRECATED 2026-07-24 (Workstream C). Superseded by `pnpm gh:wellness`
// (Google Health) before the Fitbit Web API sunsets Sept 2026. Kept during cutover.
//
// Fitbit physical-activity backfill. Idempotent + resumable.
//
//   pnpm fitbit:backfill --since=2026-07-01                 all passes
//   pnpm fitbit:backfill --since=2026-07-01 --until=2026-07-31
//   pnpm fitbit:backfill --since=2026-07-01 --only=sleep,hrv
//   pnpm fitbit:backfill --since=2026-07-01 --only=steps
//
// Passes: steps (daily activity + resting HR), run-hr (intraday HR into
// run_streams), sleep, hrv. --since is required (Fitbit history started July
// 2026). This is a REAL ingestion job — no seed guard.

const PASSES = ['steps', 'run-hr', 'sleep', 'hrv'] as const;
type Pass = (typeof PASSES)[number];

function selectedPasses(argv: string[]): Record<Pass, boolean> {
  const only = argv.find((a) => a.startsWith('--only='));
  if (!only) {
    return { steps: true, 'run-hr': true, sleep: true, hrv: true };
  }
  const set = new Set(
    only
      .slice('--only='.length)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const p of set) {
    if (!PASSES.includes(p as Pass)) {
      throw new Error(
        `backfill-fitbit: unknown pass '${p}' in --only (valid: ${PASSES.join(', ')})`,
      );
    }
  }
  return {
    steps: set.has('steps'),
    'run-hr': set.has('run-hr'),
    sleep: set.has('sleep'),
    hrv: set.has('hrv'),
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dateArg(argv: string[], flag: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`${flag}=`));
  if (!hit) return undefined;
  const value = hit.slice(flag.length + 1);
  if (!DATE_RE.test(value)) {
    throw new Error(
      `backfill-fitbit: ${flag} must be YYYY-MM-DD (got '${value}')`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  loadEnv();
  const argv = process.argv.slice(2);
  const since = dateArg(argv, '--since');
  if (!since) {
    throw new Error(
      'backfill-fitbit: --since=YYYY-MM-DD is required (e.g. --since=2026-07-01)',
    );
  }
  const until = dateArg(argv, '--until');
  const passes = selectedPasses(argv);

  const summary = await backfillFitbit({
    since,
    until,
    steps: passes.steps,
    runHr: passes['run-hr'],
    sleep: passes.sleep,
    hrv: passes.hrv,
  });

  // eslint-disable-next-line no-console
  console.log(
    `\nFitbit backfill: ${summary.daysUpserted} activity days, ` +
      `${summary.runStreamsFetched} run HR streams, ` +
      `${summary.sleepUpserted} sleep sessions, ${summary.hrvUpserted} HRV days` +
      `${summary.rateLimited ? ' (STOPPED on rate limit — re-run to resume)' : ''}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('fitbit backfill failed', { job: 'fitbit-backfill' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

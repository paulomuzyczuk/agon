import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertPlannedSession } from '../services/plannedSessions';
import { expandMonthlyTimeTrials } from '../lib/training/timeTrials';
import { logger } from '../services/logger';

// Seed four time trials a month (5 / 15 / 10 / 21.1 km, one per week) for a
// period with no program — see lib/training/timeTrials.ts. Trials inside a
// program block live in that block's program file instead. Idempotent —
// upserts on plan_key.
//
//   pnpm seed:time-trials --from=2027-01 --months=3
//
// Gated by the seed guard (assertLocalTarget); run against a remote DB only with
// ALLOW_REMOTE_SEED=1.

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-time-trials');

  const from = arg('from');
  const months = Number(arg('months') ?? '3');
  if (!from) throw new Error('seed-time-trials: --from=YYYY-MM is required');

  const sessions = expandMonthlyTimeTrials(from, months);
  for (const s of sessions) {
    await upsertPlannedSession(s);
  }

  logger.info('time trials seeded', {
    job: 'seed-time-trials',
    total: sessions.length,
    from,
    months,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${sessions.length} time trial(s): ` +
      sessions.map((s) => `${s.dateISO} ${s.targetDistanceKm} km`).join(', ') +
      '\n',
  );
}

main()
  .catch((err) => {
    logger.error('seed-time-trials failed', { job: 'seed-time-trials' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

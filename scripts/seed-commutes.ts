import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertPlannedSession } from '../services/plannedSessions';
import { expandCommuteRides } from '../lib/training/commutes';
import { getAthleteProfile } from '../lib/athleteProfile';
import { logger } from '../services/logger';

// Seed the bike commutes (to work in the morning, home in the evening) from the
// athlete profile's `commute` window — see lib/training/commutes.ts. Separate
// from the program seeds because a commute is a working-week fact, not part of
// the training program. Idempotent — upserts on plan_key; extend the window in
// config/athlete-profile.local.json and re-run.
//
//   pnpm seed:commutes
//
// Gated by the seed guard (assertLocalTarget); run against a remote DB only with
// ALLOW_REMOTE_SEED=1.

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-commutes');

  const window = getAthleteProfile().commute;
  if (!window) {
    // eslint-disable-next-line no-console
    console.log('\nNo `commute` in the athlete profile — nothing to seed.\n');
    return;
  }

  const sessions = expandCommuteRides(window);
  for (const s of sessions) {
    await upsertPlannedSession(s);
  }

  logger.info('commute rides seeded', {
    job: 'seed-commutes',
    total: sessions.length,
    from: window.from,
    until: window.until,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${sessions.length} commute ride(s) ` +
      `(${window.from} → ${window.until}, ISO weekdays ${window.weekdays.join(',')}).\n`,
  );
}

main()
  .catch((err) => {
    logger.error('seed-commutes failed', { job: 'seed-commutes' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

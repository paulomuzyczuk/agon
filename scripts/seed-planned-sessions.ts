import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertPlannedSession } from '../services/plannedSessions';
import { expandProgram } from '../lib/training/trainingProgram';
import { logger } from '../services/logger';

// Seed planned_sessions from the training program (docs/training-program.local.md,
// encoded in lib/training/trainingProgram.ts). CLAUDE.md Phase 2: "Seed planned_sessions
// from /docs/training-program.local.md + Google Calendar sync". Idempotent — upserts on
// plan_key, so re-running after a program edit updates the plan without
// duplicating rows or clobbering realized status / gcal_event_id.
//
//   pnpm seed:planned
//
// Gated by the seed guard (assertLocalTarget); run against a remote DB only with
// ALLOW_REMOTE_SEED=1.

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-planned-sessions');

  const sessions = expandProgram();
  for (const s of sessions) {
    await upsertPlannedSession(s);
  }

  const runs = sessions.filter((s) => s.sessionKind === 'run').length;
  const lifts = sessions.filter((s) => s.sessionKind === 'lift').length;
  const rests = sessions.filter((s) => s.sessionKind === 'rest').length;

  logger.info('planned sessions seeded', {
    job: 'seed-planned-sessions',
    total: sessions.length,
    runs,
    lifts,
    rests,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${sessions.length} planned session(s): ` +
      `${runs} run, ${lifts} lift, ${rests} rest ` +
      `(${sessions[0]?.dateISO} → ${sessions[sessions.length - 1]?.dateISO}).\n`,
  );
}

main()
  .catch((err) => {
    logger.error(
      'seed-planned-sessions failed',
      { job: 'seed-planned-sessions' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

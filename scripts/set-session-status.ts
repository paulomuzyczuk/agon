import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  findSessionByDateAndKind,
  setSessionStatus,
  type SessionStatus,
} from '../services/plannedSessions';
import { logger } from '../services/logger';

// Record what actually happened to a planned session WITHOUT editing the program
// itself (date, distance, description stay exactly as seeded from
// docs/training-program.local.md, so `pnpm seed:planned` never reverts this).
//
// A 'skipped' session drops out of the calendar sync, and its existing event is
// deleted on the next `pnpm gcal:sync`.
//
//   pnpm session:status 2026-08-23 lift skipped
//   pnpm session:status 2026-08-23 run completed
//   pnpm session:status 2026-08-23 lift planned     # undo

const STATUSES: SessionStatus[] = ['planned', 'synced', 'completed', 'skipped'];
const KINDS = ['run', 'lift', 'rest'] as const;

async function main(): Promise<void> {
  loadEnv();
  const [dateISO, kind, status] = process.argv
    .slice(2)
    .filter((a) => !a.startsWith('--'));

  if (!dateISO || !kind || !status) {
    throw new Error(
      'usage: pnpm session:status <YYYY-MM-DD> <run|lift|rest> <planned|synced|completed|skipped>',
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    throw new Error(`invalid date '${dateISO}' (use YYYY-MM-DD)`);
  }
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`invalid kind '${kind}' (${KINDS.join(' | ')})`);
  }
  if (!(STATUSES as string[]).includes(status)) {
    throw new Error(`invalid status '${status}' (${STATUSES.join(' | ')})`);
  }

  const session = await findSessionByDateAndKind(
    dateISO,
    kind as 'run' | 'lift' | 'rest',
  );
  if (!session) {
    throw new Error(`no ${kind} session planned for ${dateISO}`);
  }

  await setSessionStatus(session.id, status as SessionStatus);
  // eslint-disable-next-line no-console
  console.log(
    `\n${dateISO} ${kind} "${session.description}": ${session.status} → ${status}` +
      (status === 'skipped'
        ? '\nIts calendar event is removed on the next `pnpm gcal:sync`.\n'
        : '\n'),
  );
  logger.info('session status set', {
    job: 'session-status',
    sessionId: session.id,
    sessionStatus: status,
  });
}

main()
  .catch((err) => {
    logger.error('set-session-status failed', { job: 'session-status' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

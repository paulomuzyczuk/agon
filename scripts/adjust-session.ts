import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import {
  findSessionByDateAndKind,
  findSessionByCalendarDate,
  setSessionStartTime,
} from '../services/plannedSessions';
import {
  upsertAdjustment,
  clearAdjustment,
} from '../services/sessionAdjustments';
import { parseAdjustArgs } from '../lib/sessionAdjustArgs';
import { logger } from '../services/logger';

// Record a deviation from the seeded program WITHOUT editing the program. Writes
// only to session_adjustments (plus the pinned start time), so `pnpm seed:planned`
// can re-run at any time and the deviation survives.
//
//   pnpm session:adjust 2026-08-22 run --date=2026-08-23 --km=25 --note="swapped with Sunday"
//   pnpm session:adjust 2026-08-22 run --date=2026-08-23 --at=18:30   # move day AND time
//   pnpm session:adjust 2026-08-23 run --calendar --at=19:00          # address it by where it sits now
//   pnpm session:adjust 2026-08-22 run --clear
//
// By default the session is addressed by its PROGRAM date + kind (where the plan
// put it). A session already moved (here or by dragging it in Calendar) no longer
// sits on that date: pass --calendar to address it by the date it is on now.
// --date moves the day, --at the start time (HH:MM, athlete-local). The calendar
// event follows on the next `pnpm gcal:sync` (preview it with `--dry-run`).

async function main(): Promise<void> {
  loadEnv();
  const args = parseAdjustArgs(process.argv.slice(2));
  const { dateISO, kind } = args;
  const find = args.byCalendar
    ? findSessionByCalendarDate
    : findSessionByDateAndKind;
  const session = await find(dateISO, kind);
  if (!session) {
    throw new Error(
      `no ${kind} session ${args.byCalendar ? 'on the calendar' : 'planned'} for ${dateISO}` +
        (args.byCalendar
          ? ''
          : ' (if it was moved, address it by its current date with --calendar)'),
    );
  }

  if (args.clear) {
    const had = await clearAdjustment(session.id);
    // eslint-disable-next-line no-console
    console.log(
      had
        ? `\nCleared the adjustment on ${dateISO} ${kind} — back to the program.\n`
        : `\n${dateISO} ${kind} had no adjustment; nothing to clear.\n`,
    );
    return;
  }

  // Only keys the caller actually passed are patched; the rest keep their stored
  // override, so adjusting a distance doesn't silently drop a date move.
  if (Object.keys(args.patch).length > 0) {
    await upsertAdjustment(session.id, args.patch, 'manual');
  }
  if (args.startTime) {
    await setSessionStartTime(
      session.id,
      args.startTime,
      'set by hand (session:adjust)',
    );
  }
  const applied = {
    ...args.patch,
    ...(args.startTime ? { startTime: args.startTime } : {}),
  };
  // eslint-disable-next-line no-console
  console.log(
    `\nAdjusted ${dateISO} ${kind} "${session.description}": ` +
      `${JSON.stringify(applied)}\nThe calendar follows on the next \`pnpm gcal:sync\` ` +
      `(preview with \`pnpm gcal:sync --dry-run\`).\n`,
  );
  logger.info('session adjusted', {
    job: 'session-adjust',
    sessionId: session.id,
  });
}

main()
  .catch((err) => {
    logger.error('session:adjust failed', { job: 'session-adjust' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

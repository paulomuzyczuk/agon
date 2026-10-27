import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { logger } from '../services/logger';
import { sendMessage } from '../services/telegram/api';
import { getAthleteProfile } from '../lib/athleteProfile';
import {
  reconcileFromCalendar,
  defaultReconcileDeps,
  describeReconcileSummary,
} from '../services/googleCalendar/reconcile';
import { syncTrainingCalendar } from '../services/googleCalendar/sync';
import { reconcileRealized } from '../services/calendarRealized';
import { outcomeNote } from '../lib/sessionOutcome';

// Weekly calendar reconciliation (MZY-417): realized data is the source of truth
// for the past, so the "Agon Training" calendar is brought in line with what the
// recorded runs and rides say happened. Run by a systemd timer on Mondays
// (deploy/agon-calendar-reconcile.timer).
//
//   pnpm gcal:weekly-reconcile                dry run — prints what would change
//   pnpm gcal:weekly-reconcile --write        apply, push to Calendar, notify
//     --days=N         look back N days (default 14)
//     --no-telegram    print only
//
// Order matters. (1) read the athlete's own calendar edits back first, so a move
// made in Calendar sets the session's date and is what the data is attributed
// to; (2) attribute recorded activity to sessions by that date, mark each
// done / not done; (3) push the result to Calendar. Future sessions are never
// touched by step 2; hand edits to them still win.

const argVal = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const dayOf = (d: Date, timeZone: string): string =>
  d.toLocaleDateString('sv-SE', { timeZone });

async function notify(message: string, enabled: boolean): Promise<void> {
  const chatId = Number(process.env.TELEGRAM_OWNER_CHAT_ID);
  if (!enabled || !chatId) return;
  try {
    await sendMessage(chatId, message);
  } catch (err) {
    logger.warn('weekly calendar reconcile summary could not be sent', {
      job: 'weekly-calendar-reconcile',
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  loadEnv();
  const write = process.argv.includes('--write');
  const { timeZone } = getAthleteProfile();
  const days = Number(argVal('days') ?? 14);
  const now = new Date();
  const today = dayOf(now, timeZone);
  const fromISO = dayOf(new Date(now.getTime() - days * 86_400_000), timeZone);
  const toISO = dayOf(new Date(now.getTime() - 86_400_000), timeZone);

  // Only events Agon has a snapshot of: without one a changed default slot is
  // indistinguishable from a hand edit, so those are left for the next sync to
  // snapshot rather than guessed at.
  const edits = await reconcileFromCalendar(
    { fromISO, dryRun: !write },
    {
      ...defaultReconcileDeps,
      getSessions: async (from, ids) =>
        (await defaultReconcileDeps.getSessions(from, ids)).filter(
          (s) => s.gcalPushed !== null,
        ),
    },
  );
  const realized = await reconcileRealized({
    fromISO,
    toISO,
    timeZone,
    dryRun: !write,
  });

  const lines = [
    `Calendar vs data, ${fromISO} → ${toISO} (today ${today}):`,
    `${realized.examined} sessions checked — ${realized.done} done, ${realized.notDone} not done, ${realized.changes.length} to update.`,
    ...realized.changes.map(
      (c) => `  ${c.date} ${c.description}: ${outcomeNote(c.outcome)}`,
    ),
    describeReconcileSummary(edits, !write).trim(),
  ];
  // eslint-disable-next-line no-console
  console.log(`\n${lines.join('\n')}\n`);

  if (!write) {
    // eslint-disable-next-line no-console
    console.log('(dry run — pass --write to apply)\n');
    return;
  }
  const synced = await syncTrainingCalendar({ fromISO });
  logger.info('weekly calendar reconcile complete', {
    job: 'weekly-calendar-reconcile',
    examined: realized.examined,
    changed: realized.changes.length,
    eventsUpdated: synced.updated,
  });
  await notify(
    `📅 Calendar reconciled with data (${fromISO} → ${toISO}): ` +
      `${realized.done} done, ${realized.notDone} not done, ` +
      `${realized.changes.length} event(s) updated.`,
    !process.argv.includes('--no-telegram'),
  );
}

main()
  .catch((err) => {
    logger.error(
      'gcal:weekly-reconcile failed',
      { job: 'weekly-calendar-reconcile' },
      err,
    );
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

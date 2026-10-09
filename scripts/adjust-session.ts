import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { findSessionByDateAndKind } from '../services/plannedSessions';
import {
  upsertAdjustment,
  clearAdjustment,
} from '../services/sessionAdjustments';
import { logger } from '../services/logger';

// Record a deviation from the seeded program WITHOUT editing the program. Writes
// only to session_adjustments, so `pnpm seed:planned` can re-run at any time and
// the deviation survives.
//
//   pnpm session:adjust 2026-08-22 run --date=2026-08-23 --km=25 --note="swapped with Sunday"
//   pnpm session:adjust 2026-08-22 run --clear
//
// Address the session by its PROGRAM date + kind (where the plan put it), then
// --date moves it. The calendar event follows on the next `pnpm gcal:sync`.

function argVal(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(`--${name}=`.length) : undefined;
}

async function main(): Promise<void> {
  loadEnv();
  const [dateISO, kind] = process.argv
    .slice(2)
    .filter((a) => !a.startsWith('--'));
  if (!dateISO || !kind) {
    throw new Error(
      'usage: pnpm session:adjust <YYYY-MM-DD> <run|lift|rest> ' +
        '[--date=] [--km=] [--hr-cap=] [--type=] [--desc=] [--note=] | --clear',
    );
  }
  const session = await findSessionByDateAndKind(
    dateISO,
    kind as 'run' | 'lift' | 'rest',
  );
  if (!session) throw new Error(`no ${kind} session planned for ${dateISO}`);

  if (process.argv.includes('--clear')) {
    const had = await clearAdjustment(session.id);
    // eslint-disable-next-line no-console
    console.log(
      had
        ? `\nCleared the adjustment on ${dateISO} ${kind} — back to the program.\n`
        : `\n${dateISO} ${kind} had no adjustment; nothing to clear.\n`,
    );
    return;
  }

  const km = argVal('km');
  const hrCap = argVal('hr-cap');
  // Only keys the caller actually passed are patched; the rest keep their stored
  // override, so adjusting a distance doesn't silently drop a date move.
  const patch = {
    ...(argVal('date') !== undefined ? { date: argVal('date') } : {}),
    ...(argVal('desc') !== undefined ? { description: argVal('desc') } : {}),
    ...(km !== undefined ? { targetDistanceKm: Number(km) } : {}),
    ...(hrCap !== undefined ? { targetHrCap: Number(hrCap) } : {}),
    ...(argVal('type') !== undefined
      ? { targetSessionType: argVal('type') }
      : {}),
    ...(argVal('note') !== undefined ? { note: argVal('note') } : {}),
  };
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'nothing to adjust — pass at least one override or --clear',
    );
  }
  if (km !== undefined && !(Number(km) >= 0)) {
    throw new Error(`invalid --km '${km}'`);
  }

  await upsertAdjustment(session.id, patch, 'manual');
  // eslint-disable-next-line no-console
  console.log(
    `\nAdjusted ${dateISO} ${kind} "${session.description}": ` +
      `${JSON.stringify(patch)}\nThe calendar follows on the next \`pnpm gcal:sync\`.\n`,
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

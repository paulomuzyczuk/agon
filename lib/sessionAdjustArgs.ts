// Argument parsing for `pnpm session:adjust` (pure — no I/O, unit-tested).
// Failure messages name the flag, what was expected and what was received.

export const SESSION_KINDS = ['run', 'lift', 'bike', 'rest'] as const;
export type SessionKindArg = (typeof SESSION_KINDS)[number];

export interface AdjustArgs {
  /** The date the session is addressed by (program date, or calendar date with --calendar). */
  dateISO: string;
  kind: SessionKindArg;
  clear: boolean;
  /** Address the session by the date it sits on now, not the date the program gave it. */
  byCalendar: boolean;
  /** Overlay fields to patch; only the flags actually passed are present. */
  patch: {
    date?: string;
    description?: string;
    targetDistanceKm?: number;
    targetHrCap?: number;
    targetSessionType?: string;
    note?: string;
  };
  /** New start time (HH:MM, athlete-local), pinned as a strong time. */
  startTime?: string;
}

export const ADJUST_USAGE =
  'usage: pnpm session:adjust <YYYY-MM-DD> <run|lift|bike|rest> ' +
  '[--calendar] [--date=YYYY-MM-DD] [--at=HH:MM] [--km=] [--hr-cap=] ' +
  '[--type=] [--desc=] [--note=] | --clear';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function flag(argv: string[], name: string): string | undefined {
  const arg = argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.slice(`--${name}=`.length) : undefined;
}

function isoDate(raw: string, label: string): string {
  if (!ISO_DATE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    throw new Error(`${label} must be a date like 2026-10-29 (got '${raw}')`);
  }
  return raw;
}

function nonNegative(raw: string, label: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a number >= 0 (got '${raw}')`);
  }
  return n;
}

export function parseAdjustArgs(argv: string[]): AdjustArgs {
  const [dateArg, kindArg] = argv.filter((a) => !a.startsWith('--'));
  if (!dateArg || !kindArg) throw new Error(ADJUST_USAGE);
  if (!(SESSION_KINDS as readonly string[]).includes(kindArg)) {
    throw new Error(
      `session kind must be one of ${SESSION_KINDS.join(', ')} (got '${kindArg}')`,
    );
  }
  const date = flag(argv, 'date');
  const at = flag(argv, 'at');
  const km = flag(argv, 'km');
  const hrCap = flag(argv, 'hr-cap');
  const type = flag(argv, 'type');
  const desc = flag(argv, 'desc');
  const note = flag(argv, 'note');

  if (at !== undefined && !CLOCK.test(at)) {
    throw new Error(`--at must be a 24-hour time like 18:30 (got '${at}')`);
  }
  const patch: AdjustArgs['patch'] = {
    ...(date !== undefined ? { date: isoDate(date, '--date') } : {}),
    ...(desc !== undefined ? { description: desc } : {}),
    ...(km !== undefined ? { targetDistanceKm: nonNegative(km, '--km') } : {}),
    ...(hrCap !== undefined
      ? { targetHrCap: nonNegative(hrCap, '--hr-cap') }
      : {}),
    ...(type !== undefined ? { targetSessionType: type } : {}),
    ...(note !== undefined ? { note } : {}),
  };
  const clear = argv.includes('--clear');
  if (!clear && Object.keys(patch).length === 0 && at === undefined) {
    throw new Error(
      'nothing to adjust — pass at least one override (--date, --at, --km, …) or --clear',
    );
  }
  return {
    dateISO: isoDate(dateArg, 'the session date'),
    kind: kindArg as SessionKindArg,
    clear,
    byCalendar: argv.includes('--calendar'),
    patch,
    ...(at !== undefined ? { startTime: at } : {}),
  };
}

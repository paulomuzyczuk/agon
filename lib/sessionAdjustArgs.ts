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

type PatchKey = keyof AdjustArgs['patch'];

// One row per overlay flag: its name, the field it sets and how to read it.
const PATCH_FLAGS: [string, PatchKey, (raw: string) => string | number][] = [
  ['date', 'date', (v) => isoDate(v, '--date')],
  ['desc', 'description', (v) => v],
  ['km', 'targetDistanceKm', (v) => nonNegative(v, '--km')],
  ['hr-cap', 'targetHrCap', (v) => nonNegative(v, '--hr-cap')],
  ['type', 'targetSessionType', (v) => v],
  ['note', 'note', (v) => v],
];

function buildPatch(argv: string[]): AdjustArgs['patch'] {
  const patch: Record<string, string | number> = {};
  for (const [name, key, read] of PATCH_FLAGS) {
    const raw = flag(argv, name);
    if (raw !== undefined) patch[key] = read(raw);
  }
  return patch;
}

function startTimeArg(argv: string[]): string | undefined {
  const at = flag(argv, 'at');
  if (at !== undefined && !CLOCK.test(at)) {
    throw new Error(`--at must be a 24-hour time like 18:30 (got '${at}')`);
  }
  return at;
}

function sessionKind(raw: string): SessionKindArg {
  if (!(SESSION_KINDS as readonly string[]).includes(raw)) {
    throw new Error(
      `session kind must be one of ${SESSION_KINDS.join(', ')} (got '${raw}')`,
    );
  }
  return raw as SessionKindArg;
}

export function parseAdjustArgs(argv: string[]): AdjustArgs {
  const [dateArg, kindArg] = argv.filter((a) => !a.startsWith('--'));
  if (!dateArg || !kindArg) throw new Error(ADJUST_USAGE);
  const kind = sessionKind(kindArg);
  const dateISO = isoDate(dateArg, 'the session date');
  const startTime = startTimeArg(argv);
  const patch = buildPatch(argv);
  const clear = argv.includes('--clear');
  if (!clear && Object.keys(patch).length === 0 && startTime === undefined) {
    throw new Error(
      'nothing to adjust — pass at least one override (--date, --at, --km, …) or --clear',
    );
  }
  return {
    dateISO,
    kind,
    clear,
    byCalendar: argv.includes('--calendar'),
    patch,
    ...(startTime !== undefined ? { startTime } : {}),
  };
}

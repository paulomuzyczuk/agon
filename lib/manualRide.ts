import { z } from 'zod';
import { DATA_SOURCES } from './constants';
import { athleteLocalToUtcISO } from './time';
import { computeBlockWeek } from './training/trainingBlocks';
import type { RideRecord } from './types';

// Pure half of the hand-logged ride path (scripts/add-manual-ride.ts): parse +
// validate the CLI flags and build the `rides` row. No I/O — overlap checks,
// gear links and derived recomputes live in the script.
//
// The standard way to record a ride no source captured (forgot to start
// Strava, a device upload Agon deliberately ignores, …). Rows land with
// source 'manual' and a deterministic external_id, so re-running the same
// command updates the ride in place instead of duplicating it.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "24:00" (mm:ss), "1:05:30" (h:mm:ss) or "1440" (seconds) → seconds. */
export function parseDurationToSeconds(raw: string): number {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(
      `invalid duration '${raw}' — use mm:ss, h:mm:ss or seconds`,
    );
  }
  if (!parts.every((p) => /^\d+$/.test(p))) {
    throw new Error(
      `invalid duration '${raw}' — use mm:ss, h:mm:ss or seconds`,
    );
  }
  const nums = parts.map(Number);
  const [h, m, sec] = nums.length === 3 ? nums : [0, nums[0]!, nums[1]!];
  if (m! > 59 && nums.length === 3)
    throw new Error(`invalid minutes in '${raw}'`);
  if (sec! > 59) throw new Error(`invalid seconds in '${raw}'`);
  return h! * 3600 + m! * 60 + sec!;
}

const ManualRideSchema = z
  .object({
    date: z.string().regex(DATE_RE, 'date must be YYYY-MM-DD'),
    start: z.string().regex(CLOCK_RE, 'start must be HH:MM (athlete-local)'),
    km: z.coerce.number().positive().max(1000),
    durationS: z.number().int().positive(),
    avgHr: z.coerce.number().int().min(30).max(260).optional(),
    maxHr: z.coerce.number().int().min(30).max(260).optional(),
    hrEstimated: z.boolean(),
    strap: z.boolean(),
    elevationM: z.coerce.number().min(0).optional(),
    rpe: z.coerce.number().int().min(1).max(10).optional(),
    // Power read off a head unit/app by hand — always provenance 'manual',
    // never fed into NP/TSS (MZY-267).
    avgPower: z.coerce.number().int().min(0).max(3000).optional(),
    maxPower: z.coerce.number().int().min(0).max(3000).optional(),
    kj: z.coerce.number().min(0).max(100000).optional(),
    bike: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
    write: z.boolean(),
    force: z.boolean(),
  })
  .refine((r) => !r.hrEstimated || r.avgHr !== undefined, {
    message: '--hr-estimated needs --avg-hr',
  })
  .refine(
    (r) => r.maxHr === undefined || r.avgHr === undefined || r.maxHr >= r.avgHr,
    { message: '--max-hr must be ≥ --avg-hr' },
  )
  .refine(
    (r) =>
      r.maxPower === undefined ||
      r.avgPower === undefined ||
      r.maxPower >= r.avgPower,
    { message: '--max-power must be ≥ --avg-power' },
  );

export type ManualRideInput = z.infer<typeof ManualRideSchema>;

/** Parse `--name=value` / `--flag` CLI args (same style as scripts/adjust-session.ts). */
export function parseManualRideArgs(argv: string[]): ManualRideInput {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`unexpected argument '${arg}'`);
    const eq = arg.indexOf('=');
    if (eq === -1) flags.add(arg.slice(2));
    else values.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  const known = new Set([
    'date',
    'start',
    'km',
    'duration',
    'avg-hr',
    'max-hr',
    'hr-estimated',
    'strap',
    'elevation',
    'rpe',
    'avg-power',
    'max-power',
    'kj',
    'bike',
    'notes',
    'write',
    'force',
  ]);
  for (const k of [...values.keys(), ...flags]) {
    if (!known.has(k)) throw new Error(`unknown option '--${k}'`);
  }
  const duration = values.get('duration');
  if (duration === undefined) throw new Error('--duration is required');

  const parsed = ManualRideSchema.safeParse({
    date: values.get('date'),
    start: values.get('start'),
    km: values.get('km'),
    durationS: parseDurationToSeconds(duration),
    avgHr: values.get('avg-hr'),
    maxHr: values.get('max-hr'),
    hrEstimated: flags.has('hr-estimated'),
    strap: flags.has('strap'),
    elevationM: values.get('elevation'),
    rpe: values.get('rpe'),
    avgPower: values.get('avg-power'),
    maxPower: values.get('max-power'),
    kj: values.get('kj'),
    bike: values.get('bike'),
    notes: values.get('notes'),
    write: flags.has('write'),
    force: flags.has('force'),
  });
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** Deterministic idempotency key: one manual ride per local start minute. */
export function manualRideExternalId(date: string, start: string): string {
  return `manual-${date}-${start.replace(':', '')}`;
}

function hasManualPower(input: ManualRideInput): boolean {
  return (
    input.avgPower !== undefined ||
    input.maxPower !== undefined ||
    input.kj !== undefined
  );
}

/** Provenance line(s) stored in rides.general_notes. */
export function manualRideNotes(input: ManualRideInput): string {
  const parts = [
    'Logged by hand (pnpm ride:add) — no source recorded this ride.',
  ];
  if (input.hrEstimated) {
    parts.push(
      `avg HR ${input.avgHr} bpm is the athlete's estimate, not measured.`,
    );
  }
  if (hasManualPower(input)) {
    parts.push('Power figures were entered by hand, not measured by Agon.');
  }
  if (input.notes) parts.push(input.notes);
  return parts.join(' ');
}

export function buildManualRideRecord(
  input: ManualRideInput,
  timeZone: string,
  bikeName: string | null,
): RideRecord {
  const { block, week } = computeBlockWeek(input.date);
  const round = (n: number, dp: number): number =>
    Math.round(n * 10 ** dp) / 10 ** dp;
  return {
    date: input.date,
    started_at: athleteLocalToUtcISO(
      `${input.date}T${input.start}:00`,
      timeZone,
    ),
    start_lat: null,
    start_lng: null,
    block,
    week,
    distance_km: round(input.km, 3),
    duration_s: input.durationS,
    avg_hr: input.avgHr ?? null,
    max_hr: input.maxHr ?? null,
    avg_speed_kmh: round((input.km / input.durationS) * 3600, 2),
    max_speed_kmh: null,
    elevation_gain_m: input.elevationM ?? null,
    bike_used: bikeName,
    avg_power_w: input.avgPower ?? null,
    max_power_w: input.maxPower ?? null,
    weighted_avg_power_w: null,
    kilojoules: input.kj ?? null,
    power_source: hasManualPower(input) ? 'manual' : null,
    perceived_effort: input.rpe ?? null,
    general_notes: manualRideNotes(input),
    external_id: manualRideExternalId(input.date, input.start),
    source: DATA_SOURCES.MANUAL,
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

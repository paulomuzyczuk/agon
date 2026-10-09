// Pure math for hand corrections of a run or ride (MZY-253). DB-free and
// unit-tested. The DB side (reading the activity + stream, writing through
// services/activityCorrections.ts, provenance, derived-row recompute) is
// services/activityCorrectionFlow.ts.
//
// The two real cases (2026-09-29, two Strava rides, fixed by hand in MZY-252):
//
//   * Missed start: the athlete forgot to press start. Add X km at the start;
//     the unrecorded time is extrapolated from the recorded FIRST-KM MOVING
//     pace (stops excluded — duration_s is moving time). The start instant
//     moves earlier by that time.
//   * Late stop: the recording was left running after getting home. Trim the
//     last N min: remove that tail's distance and moving-flagged seconds, and
//     cut every stream array at max(time_s) − N·60.
//
// Moving-time convention (matches the reference fix): the interval ending at
// sample i counts as moving when moving[i] is true. A stream without moving
// flags counts every interval.

export type CorrectionActivityKind = 'run' | 'ride';

/** The stream fields the corrections read. Index-aligned with timeS. */
export interface CorrectionStream {
  timeS: number[];
  distanceM: Array<number | null> | null;
  moving: Array<boolean | null> | null;
}

export interface ActivityTotals {
  distanceKm: number;
  durationS: number;
  /** ISO instant; null for an activity with no known start. */
  startedAt: string | null;
}

export type CorrectionRequest =
  | { kind: 'missed_start'; addKm: number }
  | { kind: 'late_stop'; trimMin: number }
  | { kind: 'totals'; distanceKm?: number; durationS?: number };

/** One applied correction, in the qualitative_logs parsed_json.corrections[] shape. */
export type CorrectionLogEntry =
  | {
      kind: 'missed_start';
      distance_km: number;
      duration_s: number;
      pace_basis_s_per_km: number;
      pace_basis: PaceBasis;
      start_shift_s: number;
    }
  | {
      kind: 'late_stop_trim';
      distance_km: number;
      duration_s: number;
      trimmed_elapsed_s: number;
      stream_cut_at_s: number;
    }
  | {
      kind: 'totals';
      distance_km: number;
      duration_s: number;
    };

/**
 * Where a missed start's pace came from: the first km of the moving-flagged
 * stream, the first km of an unflagged stream (elapsed), or — no distance
 * stream at all — the activity's own average moving pace.
 */
export type PaceBasis = 'first_km_moving' | 'first_km_elapsed' | 'activity_avg';

export interface CorrectionStep {
  entry: CorrectionLogEntry;
  /** One human-readable provenance line for general_notes. */
  note: string;
}

export interface CorrectionPlan {
  before: ActivityTotals;
  after: ActivityTotals;
  steps: CorrectionStep[];
  /** Keep stream samples with time_s ≤ this (late stop only). Null = streams untouched. */
  streamCutAtS: number | null;
}

export class CorrectionError extends Error {}

const FIRST_KM_M = 1000;

/** Distance to 3 dp (numeric(7,3)). */
export const roundKm = (km: number): number => Math.round(km * 1000) / 1000;

/** Average pace, s/km (runs.avg_pace_s_per_km, numeric(7,2)). */
export function avgPaceSPerKm(
  distanceKm: number,
  durationS: number,
): number | null {
  if (!(distanceKm > 0) || !(durationS > 0)) return null;
  return Math.round((durationS / distanceKm) * 100) / 100;
}

/** Average speed, km/h (rides.avg_speed_kmh, numeric(6,2)). */
export function avgSpeedKmh(
  distanceKm: number,
  durationS: number,
): number | null {
  if (!(distanceKm > 0) || !(durationS > 0)) return null;
  return Math.round((distanceKm / (durationS / 3600)) * 100) / 100;
}

function hasDistance(s: CorrectionStream | null): s is CorrectionStream & {
  distanceM: Array<number | null>;
} {
  return (
    s != null &&
    s.distanceM != null &&
    s.distanceM.length === s.timeS.length &&
    s.timeS.length >= 2
  );
}

function intervalMoving(s: CorrectionStream, i: number): boolean {
  return s.moving == null ? true : s.moving[i] === true;
}

/**
 * The recorded first-km pace, s/km: moving seconds up to the first sample at
 * or past 1000 m, divided by the km actually covered there (the sample
 * usually overshoots by a few metres). Null when the stream has no distance
 * or never reaches 1 km.
 */
export function firstKmPace(
  s: CorrectionStream | null,
): { paceSPerKm: number; basis: PaceBasis } | null {
  if (!hasDistance(s)) return null;
  const d0 = s.distanceM[0] ?? 0;
  let movingS = 0;
  for (let i = 1; i < s.timeS.length; i++) {
    if (intervalMoving(s, i)) movingS += s.timeS[i]! - s.timeS[i - 1]!;
    const covered = (s.distanceM[i] ?? 0) - d0;
    if (covered >= FIRST_KM_M) {
      if (movingS <= 0) return null;
      return {
        paceSPerKm: movingS / (covered / 1000),
        basis: s.moving == null ? 'first_km_elapsed' : 'first_km_moving',
      };
    }
  }
  return null;
}

/** The unrecorded time for `addKm` missed at the start. */
export function extrapolateMissedStart(
  addKm: number,
  stream: CorrectionStream | null,
  totals: ActivityTotals,
): { durationS: number; paceSPerKm: number; basis: PaceBasis } {
  if (!(addKm > 0)) throw new CorrectionError('addKm must be positive');
  const firstKm = firstKmPace(stream);
  const pace =
    firstKm ??
    (totals.distanceKm > 0 && totals.durationS > 0
      ? {
          paceSPerKm: totals.durationS / totals.distanceKm,
          basis: 'activity_avg' as const,
        }
      : null);
  if (!pace) {
    throw new CorrectionError(
      'no pace to extrapolate from (no distance or duration)',
    );
  }
  return {
    durationS: Math.round(addKm * pace.paceSPerKm),
    paceSPerKm: pace.paceSPerKm,
    basis: pace.basis,
  };
}

/**
 * What trimming the last `trimS` seconds removes: the cut point on the stream
 * clock, the tail's distance (last sample minus the last KEPT sample), and its
 * moving seconds. Needs a stream (the cut is defined on it).
 */
export function tailTrim(
  stream: CorrectionStream | null,
  trimS: number,
): { cutAtS: number; keepCount: number; distanceKm: number; movingS: number } {
  if (!stream || stream.timeS.length < 2) {
    throw new CorrectionError('late-stop trim needs a recorded stream');
  }
  if (!(trimS > 0)) throw new CorrectionError('trim must be positive');
  const t = stream.timeS;
  const cutAtS = t[t.length - 1]! - trimS;
  const keepCount = keepCountAt(t, cutAtS);
  if (keepCount < 2) {
    throw new CorrectionError('trim would remove (almost) the whole recording');
  }
  let movingS = 0;
  for (let i = keepCount; i < t.length; i++) {
    if (intervalMoving(stream, i)) movingS += t[i]! - t[i - 1]!;
  }
  let distanceKm = 0;
  if (hasDistance(stream)) {
    const last = stream.distanceM[t.length - 1];
    const kept = stream.distanceM[keepCount - 1];
    if (last != null && kept != null)
      distanceKm = roundKm((last - kept) / 1000);
  }
  return { cutAtS, keepCount, distanceKm, movingS };
}

/** How many leading samples have time_s ≤ cutAtS. */
export function keepCountAt(timeS: number[], cutAtS: number): number {
  let n = 0;
  while (n < timeS.length && timeS[n]! <= cutAtS) n++;
  return n;
}

/** m:ss for a pace in s/km. */
export function fmtPace(sPerKm: number): string {
  const s = Math.round(sPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}/km`;
}

/** h:mm:ss / m:ss for a duration. */
export function fmtDurationS(total: number): string {
  const s = Math.round(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Apply `requests` in order to the activity's totals and return the before →
 * after preview plus one provenance step per request. Each step works on the
 * previous step's output; a trim reads the stream (its cut is on the original
 * stream clock, which a missed start never shifts).
 */
export function planCorrection(
  before: ActivityTotals,
  stream: CorrectionStream | null,
  requests: CorrectionRequest[],
): CorrectionPlan {
  if (requests.length === 0) throw new CorrectionError('no corrections given');
  if (requests.filter((r) => r.kind === 'late_stop').length > 1) {
    throw new CorrectionError('only one late-stop trim per save');
  }
  let cur: ActivityTotals = { ...before };
  let streamCutAtS: number | null = null;
  const steps: CorrectionStep[] = [];

  for (const req of requests) {
    if (req.kind === 'missed_start') {
      const x = extrapolateMissedStart(req.addKm, stream, cur);
      const addKm = roundKm(req.addKm);
      const startedAt =
        cur.startedAt == null
          ? null
          : new Date(
              Date.parse(cur.startedAt) - x.durationS * 1000,
            ).toISOString();
      cur = {
        distanceKm: roundKm(cur.distanceKm + addKm),
        durationS: cur.durationS + x.durationS,
        startedAt,
      };
      const basisLabel =
        x.basis === 'first_km_moving'
          ? 'first-km moving pace'
          : x.basis === 'first_km_elapsed'
            ? 'first-km pace'
            : 'average moving pace';
      steps.push({
        entry: {
          kind: 'missed_start',
          distance_km: addKm,
          duration_s: x.durationS,
          pace_basis_s_per_km: Math.round(x.paceSPerKm * 10) / 10,
          pace_basis: x.basis,
          start_shift_s: startedAt == null ? 0 : x.durationS,
        },
        note:
          `Manual correction: +${addKm.toFixed(3)} km / +${x.durationS} s ` +
          `(recording started late; time extrapolated from ${basisLabel}, ` +
          `${fmtPace(x.paceSPerKm)})` +
          (startedAt == null ? '.' : `; start moved ${x.durationS} s earlier.`),
      });
    } else if (req.kind === 'late_stop') {
      const trimS = Math.round(req.trimMin * 60);
      const t = tailTrim(stream, trimS);
      cur = {
        ...cur,
        distanceKm: roundKm(cur.distanceKm - t.distanceKm),
        durationS: cur.durationS - t.movingS,
      };
      if (!(cur.distanceKm > 0) || !(cur.durationS > 0)) {
        throw new CorrectionError(
          'trim would leave no distance or moving time',
        );
      }
      streamCutAtS = t.cutAtS;
      steps.push({
        entry: {
          kind: 'late_stop_trim',
          distance_km: -t.distanceKm,
          duration_s: -t.movingS,
          trimmed_elapsed_s: trimS,
          stream_cut_at_s: t.cutAtS,
        },
        note:
          `Manual correction: last ${fmtDurationS(trimS)} trimmed (recording left running) — ` +
          `−${t.distanceKm.toFixed(3)} km / −${t.movingS} s moving; stream cut at ${t.cutAtS} s.`,
      });
    } else {
      const distanceKm =
        req.distanceKm != null ? roundKm(req.distanceKm) : cur.distanceKm;
      const durationS =
        req.durationS != null ? Math.round(req.durationS) : cur.durationS;
      if (!(distanceKm > 0) || !(durationS > 0)) {
        throw new CorrectionError('distance and moving time must be positive');
      }
      const parts: string[] = [];
      if (distanceKm !== cur.distanceKm) {
        parts.push(
          `distance ${cur.distanceKm.toFixed(3)} → ${distanceKm.toFixed(3)} km`,
        );
      }
      if (durationS !== cur.durationS) {
        parts.push(
          `moving time ${fmtDurationS(cur.durationS)} → ${fmtDurationS(durationS)}`,
        );
      }
      if (parts.length === 0) throw new CorrectionError('totals unchanged');
      steps.push({
        entry: {
          kind: 'totals',
          distance_km: roundKm(distanceKm - cur.distanceKm),
          duration_s: durationS - cur.durationS,
        },
        note: `Manual correction: ${parts.join(', ')}.`,
      });
      cur = { ...cur, distanceKm, durationS };
    }
  }

  return { before, after: cur, steps, streamCutAtS };
}

/** A run/ride's hand-correction state, as the detail pages show it. */
export interface ActivityCorrectionState {
  /** Columns the athlete corrected (runs/rides.corrected_fields). */
  correctedFields: string[];
  startedAt: string | null;
  /** The source's own start, set once a correction moved started_at. */
  sourceStartedAt: string | null;
}

/**
 * Columns reverted together — reverting distance alone would leave a
 * corrected pace/speed contradicting the source distance.
 */
export const REVERT_GROUPS = {
  totals: {
    run: ['distance_km', 'duration_s', 'avg_pace_s_per_km'],
    ride: ['distance_km', 'duration_s', 'avg_speed_kmh'],
  },
  start: ['started_at', 'date', 'block', 'week'],
} as const;

export type RevertGroup = keyof typeof REVERT_GROUPS;

/** The columns a revert group covers for this activity kind. */
export function revertGroupFields(
  kind: CorrectionActivityKind,
  group: RevertGroup,
): readonly string[] {
  return group === 'totals' ? REVERT_GROUPS.totals[kind] : REVERT_GROUPS.start;
}

/** PATCH …?dryRun response: the plan plus the derived average, before → after. */
export interface CorrectionPreview {
  kind: CorrectionActivityKind;
  plan: CorrectionPlan;
  /** avg_pace_s_per_km (runs) / avg_speed_kmh (rides), before → after. */
  rate: { before: number | null; after: number | null };
}

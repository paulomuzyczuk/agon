import { athleteLocalParts, athleteLocalToUtcISO } from '../../lib/time';
import { getAthleteProfile } from '../../lib/athleteProfile';
import type { DailyActivityRecord } from '../dailyActivity';
import type { SleepSessionRecord, HrvDailyRecord } from '../wellness';
import type { WellnessDataPoint } from './types';

// Pure payload mapping + daily-activity assembly + filter builders for the Google
// Health wellness pull (Workstream C). No I/O — split out of wellness.ts (the
// orchestrator) to keep each file under the size budget and this half trivially
// unit-testable. See wellness.ts for the module-level rationale.
//
// Shapes here were VERIFIED LIVE 2026-07-24 against the athlete's real account
// (snake_case filter paths; structured {year,month,day} daily dates;
// active-zone-minutes; HRV avg + deep RMSSD) — see docs/run-ingestion-migration.md
// §6 "Live verification". `sleep` couldn't be verified (403 until the sleep scope
// is granted), so mapSleepSession stays best-effort `TODO(live)`. Value reads still
// try several candidate field names and degrade to null (never throw), and days are
// bucketed to the athlete-local day CLIENT-side, so any remaining mismatch costs
// coverage, not correctness.

const TZ = getAthleteProfile().timeZone;

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

// ── Pure payload readers ──────────────────────────────────────────────────────

/**
 * kebab dataType id → the camelCase union field carrying the value on a DataPoint
 * (verified for `exercise` → `dataPoint.exercise`). e.g. 'active-minutes' →
 * 'activeMinutes', 'daily-resting-heart-rate' → 'dailyRestingHeartRate'.
 */
export function unionField(dataType: string): string {
  return dataType.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** The value object for a dataType on a point (`dp[unionField(dataType)]`), or null. */
export function valueObject(
  dp: WellnessDataPoint,
  dataType: string,
): Record<string, unknown> | null {
  const v = (dp as Record<string, unknown>)[unionField(dataType)];
  return v != null && typeof v === 'object'
    ? (v as Record<string, unknown>)
    : null;
}

/** The trailing id of a DataPoint resource name (`.../dataPoints/{id}`), or null. */
export function wellnessExternalId(dp: WellnessDataPoint): string | null {
  if (!dp.name) return null;
  const id = dp.name.split('/').pop();
  return id && id.length > 0 ? id : null;
}

/**
 * First finite number among the candidate fields of an object. Google encodes
 * int64 as a STRING (bpm/steps), so numeric strings are coerced. Returns null when
 * none match — the reason value reads never throw on an unexpected shape.
 */
export function readNumber(
  obj: Record<string, unknown> | null,
  candidates: string[],
): number | null {
  if (!obj) return null;
  for (const key of candidates) {
    const raw = obj[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * RFC-3339 instant this value covers, for bucketing to a local day. Interval types
 * carry `interval.startTime`; session/other types may carry a bare `startTime` or
 * `time`. Returns the raw string or null. (Daily types instead carry a structured
 * `date` object — see structuredDateToISO.)
 */
export function readValueStart(
  obj: Record<string, unknown> | null,
): string | null {
  if (!obj) return null;
  const interval = obj.interval;
  if (interval && typeof interval === 'object') {
    const st = (interval as Record<string, unknown>).startTime;
    if (typeof st === 'string') return st;
  }
  for (const key of ['startTime', 'time']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  // Some values carry `date` as a plain YYYY-MM-DD string (tolerated).
  const d = obj.date;
  if (typeof d === 'string' && d.length > 0) return d;
  return null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Verified live 2026-07-24: daily dataTypes carry the calendar day as a structured
 * `{ year, month, day }` object (already athlete-local), NOT an ISO string. Convert
 * it to YYYY-MM-DD, or null if not that shape.
 */
export function structuredDateToISO(d: unknown): string | null {
  if (!d || typeof d !== 'object') return null;
  const o = d as Record<string, unknown>;
  const { year, month, day } = o;
  if (
    typeof year === 'number' &&
    typeof month === 'number' &&
    typeof day === 'number'
  ) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
}

/** Athlete-local calendar day (YYYY-MM-DD) of a value, or null. */
function localDayOf(obj: Record<string, unknown> | null): string | null {
  if (!obj) return null;
  // Daily types: a structured {year,month,day} (already local).
  const structured = structuredDateToISO(obj.date);
  if (structured) return structured;
  // Interval/session types: an RFC-3339 instant → shift to the local calendar day.
  const raw = readValueStart(obj);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  try {
    return athleteLocalParts(raw, TZ).date;
  } catch {
    return null;
  }
}

// ── Daily activity assembly ───────────────────────────────────────────────────
// Google Health splits what Fitbit returned as one daily summary into separate
// dataTypes, so a daily_activity row is assembled by folding several pulls,
// bucketed to the athlete-local day. `sum` metrics accumulate interval values;
// `set` metrics (already daily) take the single value.

export type ActivityKey =
  | 'steps'
  | 'distanceKm'
  | 'floors'
  | 'activeMinutes'
  | 'caloriesOut'
  | 'restingHr';

export interface ActivityMetricSpec {
  dataType: string;
  key: ActivityKey;
  kind: 'interval' | 'daily';
  mode: 'sum' | 'set';
  /** candidate value field names (TODO(live): pin the real one). */
  fields: string[];
  /** multiply the raw value (e.g. mm → km). */
  scale: number;
}

// Verified live 2026-07-24 against the athlete's real Google Health account. Only
// metrics that List delivers CORRECTLY are assembled here:
//   - `active-zone-minutes` — the "active minutes" analog: per-HR-zone, per-minute
//     rows (value `activeZoneMinutes`) in DISCRETE, non-overlapping 1-minute
//     buckets, so summing to a daily total is correct. (Zone-minutes, not Fitbit's
//     fairly+very-active minutes.)
//   - `daily-resting-heart-rate` — a daily singleton (value `beatsPerMinute`).
//
// steps / distance / floors / calories are DELIBERATELY NOT pulled via List here —
// they're CUMULATIVE daily totals, and List can't give them correctly:
//   - steps / distance: List returns raw sub-minute samples from MULTIPLE
//     overlapping sources (Fitbit passive + Health Connect), and even within one
//     source the intervals are overlapping rolling windows — summing them triple-
//     counts (a real day came to ~102k "steps").
//   - floors / total-calories: do NOT support List at all (rollup only).
// Resolved 2026-08-26: all four are sourced via `dailyRollUp` instead (see
// ROLLUP_METRICS below), which returns one correct total per calendar day.
export const ACTIVITY_METRICS: readonly ActivityMetricSpec[] = [
  {
    dataType: 'active-zone-minutes',
    key: 'activeMinutes',
    kind: 'interval',
    mode: 'sum',
    fields: ['activeZoneMinutes', 'minutes'],
    scale: 1,
  },
  {
    dataType: 'daily-resting-heart-rate',
    key: 'restingHr',
    kind: 'daily',
    mode: 'set',
    fields: ['beatsPerMinute', 'bpm'],
    scale: 1,
  },
] as const;

/** Per-local-day accumulator keyed by ActivityKey. */
export type ActivityAccumulator = Map<
  string,
  Partial<Record<ActivityKey, number>>
>;

/**
 * Fold one dataType's points into the accumulator (pure). `sum` adds, `set`
 * overwrites. Points whose local day can't be resolved, or whose value is absent,
 * are skipped.
 */
export function foldActivityPoints(
  acc: ActivityAccumulator,
  spec: ActivityMetricSpec,
  points: WellnessDataPoint[],
): void {
  for (const dp of points) {
    const obj = valueObject(dp, spec.dataType);
    const day = localDayOf(obj);
    if (!day) continue;
    const raw = readNumber(obj, spec.fields);
    if (raw == null) continue;
    const value = raw * spec.scale;
    const bucket = acc.get(day) ?? {};
    bucket[spec.key] =
      spec.mode === 'sum' ? (bucket[spec.key] ?? 0) + value : value;
    acc.set(day, bucket);
  }
}

/** Build the DailyActivityRecords from a filled accumulator (pure). */
export function accumulatorToRecords(
  acc: ActivityAccumulator,
): DailyActivityRecord[] {
  const out: DailyActivityRecord[] = [];
  for (const [date, b] of acc) {
    out.push({
      date,
      source: 'google_health',
      steps: b.steps != null ? Math.round(b.steps) : null,
      distanceKm: b.distanceKm != null ? round(b.distanceKm, 3) : null,
      floors: b.floors != null ? Math.round(b.floors) : null,
      activeMinutes:
        b.activeMinutes != null ? Math.round(b.activeMinutes) : null,
      // Google exposes sedentary minutes as its own dataType; not pulled yet.
      sedentaryMinutes: null,
      caloriesOut: b.caloriesOut != null ? round(b.caloriesOut, 1) : null,
      restingHr: b.restingHr != null ? Math.round(b.restingHr) : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Daily rollup (steps/distance/floors/calories) mapping lives in ./rollupMap —
// split out to stay under the file-size budget. It reuses readNumber and
// structuredDateToISO from this file and feeds the SAME ActivityAccumulator
// foldActivityPoints above fills.

// ── Sleep + HRV mappers (pure) ────────────────────────────────────────────────

/** Whole minutes between two RFC-3339 instants, or 0 if either is unparseable. */
function minutesBetween(startISO: unknown, endISO: unknown): number {
  if (typeof startISO !== 'string' || typeof endISO !== 'string') return 0;
  const s = Date.parse(startISO);
  const e = Date.parse(endISO);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0;
  return (e - s) / 60_000;
}

/**
 * Map a Google Health `sleep` session to a sleep_sessions row. dateOfSleep is the
 * athlete-local day you woke (the interval end), matching Fitbit's convention.
 *
 * Live shape (verified 2026-08-20, Fitbit via Google Health): `sleep.stages` is an
 * ARRAY of typed stage intervals — `{ startTime, endTime, type }` with type in
 * AWAKE / LIGHT / REM / DEEP (STAGES sleep) or AWAKE / ASLEEP / RESTLESS (classic).
 * There is NO minutesAsleep / efficiency / isMainSleep summary field, so totals are
 * DERIVED: per-stage minutes are summed from durations, asleep = every non-AWAKE
 * stage, timeInBed = the interval, efficiency = asleep / timeInBed. isMainSleep is
 * unknown per-point (no cross-session context here) and stays null.
 * Returns null when the session has no id (can't key it) or no usable interval.
 */
export function mapSleepSession(
  dp: WellnessDataPoint,
): SleepSessionRecord | null {
  const externalId = wellnessExternalId(dp);
  if (!externalId) return null;
  const obj = valueObject(dp, 'sleep');
  if (!obj) return null;

  const interval =
    obj.interval && typeof obj.interval === 'object'
      ? (obj.interval as Record<string, unknown>)
      : null;
  const startRaw =
    typeof interval?.startTime === 'string' ? interval.startTime : null;
  const endRaw =
    typeof interval?.endTime === 'string' ? interval.endTime : null;
  if (!startRaw && !endRaw) return null;

  const startAt = startRaw ? new Date(startRaw).toISOString() : null;
  const endAt = endRaw ? new Date(endRaw).toISOString() : null;
  // Wake day (local) — prefer the end instant, fall back to the start.
  const date = localDayOf({ startTime: endRaw ?? startRaw ?? undefined });

  // Sum stage durations (minutes) by type from the stages array.
  const stages = Array.isArray(obj.stages) ? obj.stages : [];
  const minByType = new Map<string, number>();
  for (const raw of stages) {
    if (!raw || typeof raw !== 'object') continue;
    const st = raw as Record<string, unknown>;
    const type = typeof st.type === 'string' ? st.type.toUpperCase() : null;
    if (!type) continue;
    minByType.set(
      type,
      (minByType.get(type) ?? 0) + minutesBetween(st.startTime, st.endTime),
    );
  }
  const roundOrNull = (t: string): number | null =>
    minByType.has(t) ? Math.round(minByType.get(t)!) : null;

  const hasStages = stages.length > 0;
  let asleep = 0;
  let awake = 0;
  for (const [type, min] of minByType) {
    if (type === 'AWAKE') awake += min;
    else asleep += min;
  }
  const timeInBed = startRaw && endRaw ? minutesBetween(startRaw, endRaw) : 0;
  const minutesAsleep = hasStages ? Math.round(asleep) : null;
  const efficiency =
    hasStages && timeInBed > 0 ? Math.round((asleep / timeInBed) * 100) : null;

  return {
    date: date ?? (endAt ?? startAt ?? '').slice(0, 10),
    source: 'google_health',
    externalId,
    logId: null,
    startAt,
    endAt,
    // Not present in the Google Health sleep payload; can't be inferred per-point.
    isMainSleep: null,
    minutesAsleep,
    minutesAwake: hasStages ? Math.round(awake) : null,
    timeInBed: timeInBed > 0 ? Math.round(timeInBed) : null,
    efficiency,
    // Stage-specific columns only meaningful for STAGES logs (classic uses
    // ASLEEP/RESTLESS, which fold into minutesAsleep but not these).
    deepMin: roundOrNull('DEEP'),
    lightMin: roundOrNull('LIGHT'),
    remMin: roundOrNull('REM'),
    wakeMin: roundOrNull('AWAKE'),
  };
}

/**
 * Map a Google Health `daily-heart-rate-variability` point to an hrv_daily row.
 * Verified live 2026-07-24: the value carries `averageHeartRateVariabilityMilliseconds`
 * (the daily RMSSD) AND `deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds`
 * (deep-sleep RMSSD) — so BOTH map cleanly (Fitbit's deepRmssd analog exists after
 * all). Returns null when neither a day nor a daily RMSSD can be read.
 */
export function mapDailyHrv(dp: WellnessDataPoint): HrvDailyRecord | null {
  const obj = valueObject(dp, 'daily-heart-rate-variability');
  const date = localDayOf(obj);
  const rmssd = readNumber(obj, [
    'averageHeartRateVariabilityMilliseconds',
    'rmssdMilliseconds',
    'dailyRmssd',
    'rmssd',
  ]);
  if (!date || rmssd == null) return null;
  const deep = readNumber(obj, [
    'deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds',
    'deepRmssd',
  ]);
  return { date, source: 'google_health', dailyRmssd: rmssd, deepRmssd: deep };
}

// ── Filter builders ───────────────────────────────────────────────────────────
// Verified live 2026-07-24: the filter's member path is the SNAKE_CASE dataType
// (e.g. `daily_resting_heart_rate`, `active_zone_minutes`), matching the verified
// `heart_rate.sample_time.physical_time` measurement grammar — NOT the camelCase
// union field the response uses (camelCase 400s with a "does not match any data
// type" violation). By kind:
//   - session (sleep/exercise): bare `start_time >= .. AND < ..` (RFC-3339)
//   - interval (steps/distance/active-zone-minutes): `<snake>.interval.start_time`
//   - daily (resting-hr/hrv): `<snake>.date >= "YYYY-MM-DD" AND < ".."`
// Correctness doesn't hinge on the filter: results are re-bucketed to the local
// day client-side, so a mismatch only costs extra rows.

/** The filter member path for a dataType: kebab → snake_case. */
function snakeType(dataType: string): string {
  return dataType.replace(/-/g, '_');
}

/** UTC-midnight instant of a YYYY-MM-DD local day (exclusive upper bound helper). */
function dayStartUtcISO(localDay: string): string {
  // Interpret the local day's 00:00 wall-clock in the athlete's zone (DST-aware).
  return athleteLocalToUtcISO(`${localDay}T00:00:00.000`, TZ);
}

export function sessionRangeFilter(
  sinceLocalDay: string,
  untilExclusiveLocalDay: string,
): string {
  const lo = dayStartUtcISO(sinceLocalDay);
  const hi = dayStartUtcISO(untilExclusiveLocalDay);
  return `start_time >= "${lo}" AND start_time < "${hi}"`;
}

export function intervalRangeFilter(
  dataType: string,
  sinceLocalDay: string,
  untilExclusiveLocalDay: string,
): string {
  const f = snakeType(dataType);
  const lo = dayStartUtcISO(sinceLocalDay);
  const hi = dayStartUtcISO(untilExclusiveLocalDay);
  return `${f}.interval.start_time >= "${lo}" AND ${f}.interval.start_time < "${hi}"`;
}

export function dailyRangeFilter(
  dataType: string,
  sinceLocalDay: string,
  untilExclusiveLocalDay: string,
): string {
  // Daily types compare against the local calendar date (YYYY-MM-DD), not an instant.
  const f = snakeType(dataType);
  return `${f}.date >= "${sinceLocalDay}" AND ${f}.date < "${untilExclusiveLocalDay}"`;
}

/** Pick the right range filter for a dataType kind. */
export function rangeFilterFor(
  dataType: string,
  kind: 'interval' | 'daily',
  sinceLocalDay: string,
  untilExclusiveLocalDay: string,
): string {
  return kind === 'daily'
    ? dailyRangeFilter(dataType, sinceLocalDay, untilExclusiveLocalDay)
    : intervalRangeFilter(dataType, sinceLocalDay, untilExclusiveLocalDay);
}

import {
  BIKE_ASSUMED_DURATION_MIN,
  EASY_BIKE_SPEED_KMH,
} from '../../lib/constants';
import { commuteLegOf } from '../../lib/training/commutes';
import type { EventMapOptions, PlannedSessionForEvent } from './eventMap';

// When a planned session sits on the calendar: its default slot, how a preferred
// start time moves it, and how long it lasts. planned_sessions carries a date
// but no clock time, so these defaults ARE the athlete's standard day. Split
// from eventMap.ts (which renders the event) so the writer and the reconcile
// pass share one rule for "where does the sync put it?". Pure — no DB, no clock.

// 19:00 local — after work (athlete back in an office job, 2026-10-15; was noon).
const RUN_START_HOUR = 19;
const LIFT_START_HOUR = 22; // 22:00 local (10 PM) on weekdays
const LIFT_WEEKEND_START_HOUR = 19; // 19:30 local on Sat/Sun — no late weeknight
const LIFT_WEEKEND_START_MIN = 30;
const LIFT_DURATION_MIN = 60;
const BIKE_START_HOUR = 17; // 17:00 local — distinct slot, no run/lift overlap on bike days
const BIKE_DURATION_MIN = BIKE_ASSUMED_DURATION_MIN;
const MIN_RUN_MIN = 30;

/** A wall-clock time of day. */
export interface ClockTime {
  hour: number;
  minute: number;
}

// Commute rides (lib/training/commutes.ts): leave home 08:30, leave work 18:30 —
// home again just as the 19:00 run slot starts. Half an hour is the direct ride.
const COMMUTE_TO_WORK_START: ClockTime = { hour: 8, minute: 30 };
const COMMUTE_HOME_START: ClockTime = { hour: 18, minute: 30 };
const COMMUTE_DURATION_MIN = 30;

// Rough easy/quality paces (min/km) to turn distance into a calendar block. These
// only size the event — they are not training targets.
const PACE_MIN_PER_KM: Record<string, number> = {
  easy: 6.0,
  long: 6.3,
  intervals: 5.5, // tempo incl. warm-up/cool-down
  vo2max: 5.5,
};
const DEFAULT_PACE = 6.0;
// A time trial runs faster than any training pace, but the event also has to
// hold the warm-up (2 km + strides) and cool-down around it.
const TIME_TRIAL_PACE = 5.0;
const TIME_TRIAL_EXTRA_MIN = 25;

export const pad = (n: number): string => String(n).padStart(2, '0');

/** "HH:MM" / "HH:MM:SS" → clock time, or null when absent or malformed. */
export function parseClockTime(
  raw: string | null | undefined,
): ClockTime | null {
  if (!raw) return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** "05:45" for display. */
function formatClockTime(t: ClockTime): string {
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

/** True for a Saturday or Sunday (UTC — the date is a plain calendar day). */
function isWeekend(dateISO: string): boolean {
  const day = new Date(`${dateISO}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
  return day === 0 || day === 6;
}

function sameClockTime(a: ClockTime, b: ClockTime): boolean {
  return a.hour === b.hour && a.minute === b.minute;
}

/** Estimated run duration (minutes) from distance + session type. */
export function estimateRunMinutes(
  distanceKm: number | null,
  sessionType: string | null,
): number {
  if (distanceKm === null) return 45; // shouldn't happen for a run; safe default
  if (sessionType === 'time_trial') {
    return Math.round(distanceKm * TIME_TRIAL_PACE) + TIME_TRIAL_EXTRA_MIN;
  }
  const pace = PACE_MIN_PER_KM[sessionType ?? ''] ?? DEFAULT_PACE;
  return Math.max(MIN_RUN_MIN, Math.round(distanceKm * pace));
}

/** A bike session's length: its distance at an easy spin, else the flat default. */
function bikeMinutes(distanceKm: number | null): number {
  return distanceKm !== null && distanceKm > 0
    ? Math.round((distanceKm / EASY_BIKE_SPEED_KMH) * 60)
    : BIKE_DURATION_MIN;
}

/** How long the session's event lasts, in minutes. */
export function sessionDurationMin(s: PlannedSessionForEvent): number {
  if (s.sessionKind === 'run') {
    return estimateRunMinutes(s.targetDistanceKm, s.targetSessionType);
  }
  if (s.sessionKind === 'bike') {
    return commuteLegOf(s.targetSessionType)
      ? COMMUTE_DURATION_MIN
      : bikeMinutes(s.targetDistanceKm);
  }
  return LIFT_DURATION_MIN;
}

/** The slot a session occupies with no per-session override applied. */
export function defaultStart(
  s: PlannedSessionForEvent,
  opts: EventMapOptions,
): ClockTime {
  // Runs in the evening (19:00); commutes at their fixed times; other bike rides
  // late afternoon; weekday lifts late evening (22:00), weekend lifts 19:30.
  if (s.sessionKind === 'run') {
    return { hour: opts.runStartHour ?? RUN_START_HOUR, minute: 0 };
  }
  if (s.sessionKind === 'bike') {
    const leg = commuteLegOf(s.targetSessionType);
    if (leg === 'commute_to_work') return COMMUTE_TO_WORK_START;
    if (leg === 'commute_home') return COMMUTE_HOME_START;
    return { hour: BIKE_START_HOUR, minute: 0 };
  }
  if (isWeekend(s.date)) {
    return { hour: LIFT_WEEKEND_START_HOUR, minute: LIFT_WEEKEND_START_MIN };
  }
  return { hour: opts.liftStartHour ?? LIFT_START_HOUR, minute: 0 };
}

/**
 * The description line explaining this session's timing, or null when there is
 * nothing to say (no preferred time, or it matches the default anyway).
 *
 * A moved event ALWAYS explains itself — finding a session at a new hour with no
 * stated reason is worse than not moving it. A suggestion states both times so
 * the athlete can judge the trade-off rather than being told.
 */
export function startTimeNote(
  s: PlannedSessionForEvent,
  base: ClockTime,
): string | null {
  const preferred = parseClockTime(s.startTime);
  if (!preferred || sameClockTime(preferred, base)) return null;
  const reason = s.startTimeReason?.trim();
  const because = reason ? ` — ${reason}` : '';
  return s.startTimePriority === 'strong'
    ? `⏰ Moved to ${formatClockTime(preferred)} (normally ${formatClockTime(base)})${because}`
    : `⏰ Suggestion: start at ${formatClockTime(preferred)} rather than ${formatClockTime(base)}${because}`;
}

/**
 * The wall-clock slot this session's event actually occupies — the single rule
 * for "where does the sync put it?", shared by the writer (mapSessionToEvent) and
 * the reader (the calendar reconcile pass, which must know the expected time to
 * tell a real move from a no-op).
 *
 * A preferred time only MOVES the event when it is 'strong'; a mere 'suggested'
 * time is surfaced in the description instead, so the calendar is never quietly
 * rearranged over a preference.
 */
export function effectiveStart(
  s: PlannedSessionForEvent,
  opts: EventMapOptions = {},
): ClockTime {
  const base = defaultStart(s, opts);
  const preferred = parseClockTime(s.startTime);
  const moved =
    preferred !== null &&
    s.startTimePriority === 'strong' &&
    !sameClockTime(preferred, base);
  return moved ? preferred! : base;
}

/** `effectiveStart` as "HH:MM". */
export function effectiveStartTime(
  s: PlannedSessionForEvent,
  opts: EventMapOptions = {},
): string {
  return formatClockTime(effectiveStart(s, opts));
}

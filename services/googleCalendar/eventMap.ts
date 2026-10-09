import type { CalendarEventInput } from './types';
import { getRunDetail } from '../../lib/training/sessionDetails';
import { resolvedDetailLines } from '../../lib/calendarDetail';
import { formatClimb } from '../routing/elevation';
import { estimateLongRunFueling } from '../../lib/nutritionGoals';
import { estimateFuelingBottles } from '../../lib/fuelingCatalog';
import {
  LONG_RUN_REMINDER_KM,
  CARBS_G_PER_H_MIN,
  CARBS_G_PER_H_MAX,
  FUELING_BASE_BOTTLES,
  FUELING_BOTTLE_STEP_KM,
  BIKE_ASSUMED_DURATION_MIN,
  EASY_BIKE_SPEED_KMH,
} from '../../lib/constants';
import { getAthleteProfile } from '../../lib/athleteProfile';

// Pure mapping from a planned training session to a timed Google Calendar event.
// planned_sessions carries a date but no clock time, so we assign sensible
// defaults (runs around noon, lifts late evening) and estimate a run's duration
// from its distance. The description carries the full session detail — exercises
// (sets × reps) for lifts, interval structure for quality runs — from the static
// session library. Kept pure (no DB, no Date.now) so it's unit-tested directly
// and the sync layer only handles I/O.

export const DEFAULT_TIME_ZONE = 'Europe/Berlin'; // athlete is in Berlin
const RUN_START_HOUR = 12; // 12:00 local (around noon)
const LIFT_START_HOUR = 22; // 22:00 local (10 PM) on weekdays
const LIFT_WEEKEND_START_HOUR = 19; // 19:30 local on Sat/Sun — no late weeknight
const LIFT_WEEKEND_START_MIN = 30;
const LIFT_DURATION_MIN = 60;
const BIKE_START_HOUR = 17; // 17:00 local — distinct slot, no run/lift overlap on bike days
const BIKE_DURATION_MIN = BIKE_ASSUMED_DURATION_MIN;
const MIN_RUN_MIN = 30;

/** A wall-clock time of day. */
interface ClockTime {
  hour: number;
  minute: number;
}

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

// Rough easy/quality paces (min/km) to turn distance into a calendar block. These
// only size the event — they are not training targets.
const PACE_MIN_PER_KM: Record<string, number> = {
  easy: 6.0,
  long: 6.3,
  intervals: 5.5, // tempo incl. warm-up/cool-down
  vo2max: 5.5,
};
const DEFAULT_PACE = 6.0;

/** How firmly a session's preferred start time should be applied. */
export type StartTimePriority = 'strong' | 'suggested';

/** DB-row subset needed to build an event. Rest days are filtered out upstream. */
export interface PlannedSessionForEvent {
  date: string; // YYYY-MM-DD
  block: number | null;
  week: number | null;
  sessionKind: 'run' | 'lift' | 'bike';
  description: string;
  targetDistanceKm: number | null;
  targetHrCap: number | null;
  targetSessionType: string | null;
  /** Preferred local start, "HH:MM" or "HH:MM:SS". Null → use the default slot. */
  startTime?: string | null;
  /** 'strong' moves the event; 'suggested' only advises in the description. */
  startTimePriority?: StartTimePriority | null;
  /** Why this session wants a different time — always shown when a time is set. */
  startTimeReason?: string | null;
  /**
   * Pre-rendered line explaining how this session deviates from the seeded
   * program ("📝 moved from 2026-08-22 — rest day swap"), or null when it matches.
   * Built by lib/training/sessionOverlay's adjustmentNote from the session_adjustments
   * overlay; shown near the top so a session on an unexpected day explains itself.
   */
  adjustmentNote?: string | null;
  /**
   * The athlete's hand-written detail (bike/lift, MZY-262), newline-joined safe
   * HTML, rendered in place of the program's detail. Null/absent → program's.
   */
  detail?: string | null;
}

/** A suggested route to surface in a run event's description (route builder). */
export interface EventRouteInfo {
  /** Google Maps walking deep-link, rendered as a clickable link. */
  mapsUrl: string;
  /** Actual loop distance in km. */
  distanceKm: number;
  /** Total ascent in metres, or null when unknown. */
  elevationGainM: number | null;
  /** Compass heading of the loop (N/NE/…), when known. */
  direction?: string;
  /** Place-based link text ("Route 1 · 8.3 km — Tempelhof, Schöneberg …"). */
  label?: string;
}

export interface EventMapOptions {
  timeZone?: string;
  runStartHour?: number;
  liftStartHour?: number;
  /**
   * Auto-suggested loops from home (runs and bike rides) → "🗺️ Suggested
   * routes" section.
   */
  routes?: EventRouteInfo[];
  /** Ad-hoc routes requested via Telegram /route → "🧭 Ad hoc routes" section. */
  adHocRoutes?: EventRouteInfo[];
  /**
   * Athlete's current pace/sweat-rate, resolved once per sync (not per session —
   * these are athlete-wide, not session-specific). Runs at/above
   * LONG_RUN_REMINDER_KM get a Vaseline + suggested-refueling line when present;
   * omitted/null just skips the reminder (never fails the sync).
   */
  longRunFuelingInputs?: { paceSPerKm: number; sweatRateLPerH: number } | null;
}

/** Escape text for safe HTML body content (the description is rendered as HTML). */
/** A bike session's length: its distance at an easy spin, else the flat default. */
function bikeMinutes(distanceKm: number | null): number {
  return distanceKm !== null && distanceKm > 0
    ? Math.round((distanceKm / EASY_BIKE_SPEED_KMH) * 60)
    : BIKE_DURATION_MIN;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a URL for an href attribute value. */
function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "YYYY-MM-DDTHH:MM:SS" local wall-clock (the timeZone field carries the zone). */
/**
 * Wall-clock "YYYY-MM-DDTHH:MM:00". An hour of 24 or more rolls into the next
 * day(s): a session moved late enough ends after midnight, and Google rejects
 * "T24:27" with a bare 400.
 */
function localDateTime(dateISO: string, hour: number, minute: number): string {
  const total = hour * 60 + minute;
  const dayOffset = Math.floor(total / MINUTES_PER_DAY);
  const inDay = total - dayOffset * MINUTES_PER_DAY;
  const date =
    dayOffset === 0
      ? dateISO
      : new Date(Date.parse(`${dateISO}T00:00:00Z`) + dayOffset * 86_400_000)
          .toISOString()
          .slice(0, 10);
  return `${date}T${pad(Math.floor(inDay / 60))}:${pad(inDay % 60)}:00`;
}

const MINUTES_PER_DAY = 24 * 60;

/** Add minutes to an H:M; the hour may pass 24 (localDateTime rolls the day). */
function addMinutes(
  hour: number,
  minute: number,
  add: number,
): { hour: number; minute: number } {
  const total = hour * 60 + minute + add;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/** Estimated run duration (minutes) from distance + session type. */
export function estimateRunMinutes(
  distanceKm: number | null,
  sessionType: string | null,
): number {
  if (distanceKm === null) return 45; // shouldn't happen for a run; safe default
  const pace = PACE_MIN_PER_KM[sessionType ?? ''] ?? DEFAULT_PACE;
  return Math.max(MIN_RUN_MIN, Math.round(distanceKm * pace));
}

const emojiFor = (kind: 'run' | 'lift' | 'bike'): string =>
  kind === 'run' ? '🏃' : kind === 'bike' ? '🚴' : '🏋️';

/** Render a titled section of clickable route links into the HTML line buffer. */
function renderRouteSection(
  html: string[],
  title: string,
  routes: EventRouteInfo[],
): void {
  if (routes.length === 0) return;
  html.push(htmlEscape(''));
  html.push(htmlEscape(title));
  routes.forEach((r, i) => {
    // Climb is appended to the place-based label rather than being part of the
    // fallback only — an auto route always HAS a label, so folding elevation
    // into the fallback branch meant the calendar never showed it.
    const climb = formatClimb(r.elevationGainM, r.distanceKm * 1000);
    const base =
      r.label ??
      `Route ${i + 1} · ${r.distanceKm.toFixed(1)} km${
        r.direction ? ` · heading ${r.direction}` : ''
      }`;
    const linkText = climb ? `${base} · ${climb}` : base;
    html.push(
      `• <a href="${attrEscape(r.mapsUrl)}">${htmlEscape(linkText)}</a>`,
    );
  });
}

function sameClockTime(a: ClockTime, b: ClockTime): boolean {
  return a.hour === b.hour && a.minute === b.minute;
}

/** The slot a session occupies with no per-session override applied. */
function defaultStart(
  s: PlannedSessionForEvent,
  opts: EventMapOptions,
): ClockTime {
  // Runs at noon; bike rides late afternoon; weekday lifts late evening (22:00),
  // weekend lifts earlier (19:30).
  if (s.sessionKind === 'run') {
    return { hour: opts.runStartHour ?? RUN_START_HOUR, minute: 0 };
  }
  if (s.sessionKind === 'bike') {
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

// The description is HTML (Google Calendar renders it): plain lines are escaped
// and joined with <br>; route suggestions render as clickable links whose text
// describes where each route goes, so the giant Maps URL never shows.
function buildDescription(
  s: PlannedSessionForEvent,
  routes?: EventRouteInfo[],
  adHocRoutes?: EventRouteInfo[],
  timingNote?: string | null,
  longRunFuelingInputs?: EventMapOptions['longRunFuelingInputs'],
): string {
  const html: string[] = []; // each entry is one already-HTML line
  const text = (line: string) => html.push(htmlEscape(line));

  if (s.block !== null && s.week !== null) {
    text(`Block ${s.block} · Week ${s.week}`);
  }

  // Timing and plan deviations go near the top: if the event moved — in the day
  // or in the clock — that is the first thing the athlete needs to understand
  // when they open it.
  if (s.adjustmentNote) text(s.adjustmentNote);
  if (timingNote) text(timingNote);

  if (s.sessionKind === 'run') {
    if (s.targetDistanceKm !== null) text(`Target: ${s.targetDistanceKm} km`);
    if (s.targetHrCap !== null) text(`HR cap: ${s.targetHrCap} bpm`);
    else text('Quality session — no HR cap');
    // Long runs get a Vaseline reminder + a suggested refueling strategy —
    // prompted by an actual inner-thigh chafing incident from a forgotten-
    // Vaseline 23 km run (2026-08-24). Silently skipped (never fails the sync)
    // when the athlete inputs weren't resolved.
    if (
      s.targetDistanceKm !== null &&
      s.targetDistanceKm >= LONG_RUN_REMINDER_KM &&
      longRunFuelingInputs
    ) {
      const est = estimateLongRunFueling(
        s.targetDistanceKm,
        longRunFuelingInputs.paceSPerKm,
        longRunFuelingInputs.sweatRateLPerH,
        getAthleteProfile().sweatSodiumMgPerL,
        CARBS_G_PER_H_MIN,
        CARBS_G_PER_H_MAX,
      );
      text('');
      text('🧴 Vaseline / anti-chafing balm — apply before you start');
      text(
        `🥤 Suggested refueling: ~${est.waterL}L water, ${est.carbsGMin}–${est.carbsGMax}g carbs, ` +
          `~${est.sodiumMg}mg sodium over ~${est.durationH.toFixed(1)}h`,
      );
    }
    // Quality runs (intervals/vo2max) carry a warm-up / main set / cool-down.
    const runDetail = getRunDetail(s.targetSessionType);
    if (runDetail) {
      text('');
      for (const d of runDetail) text(d);
    }
    // Two route sections: auto loops from home, then any ad-hoc /route requests.
    renderRouteSection(html, '🗺️ Suggested routes from home:', routes ?? []);
    renderRouteSection(html, '🧭 Ad hoc routes:', adHocRoutes ?? []);
  } else {
    // Bike notes / lift exercises (one per row): the athlete's hand-edited
    // detail when there is one (MZY-262), else the program's. Lines are already
    // safe HTML (lib/calendarDetail.ts), so they go in unescaped — that keeps a
    // hand-written route link clickable.
    const detail = resolvedDetailLines(
      s.sessionKind,
      s.targetSessionType,
      s.detail,
    );
    if (s.sessionKind === 'lift' && detail.length > 0) text('');
    html.push(...detail);
    if (s.sessionKind === 'bike') {
      renderRouteSection(html, '🗺️ Suggested routes from home:', routes ?? []);
      renderRouteSection(html, '🧭 Ad hoc routes:', adHocRoutes ?? []);
    }
  }

  text('');
  text('Planned by Agon');
  return html.join('<br>');
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
): { hour: number; minute: number } {
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
  const t = effectiveStart(s, opts);
  return `${pad(t.hour)}:${pad(t.minute)}`;
}

/**
 * Map a planned session to a timed Calendar event. Runs start in the morning and
 * last as long as their estimated pace × distance; lifts start in the evening for
 * a fixed hour. On a double day (run + lift on the same date) the two events sit
 * at different hours and never overlap.
 */
export function mapSessionToEvent(
  s: PlannedSessionForEvent,
  opts: EventMapOptions = {},
): CalendarEventInput {
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;

  const base = defaultStart(s, opts);
  const { hour: startHour, minute: startMinute } = effectiveStart(s, opts);

  const durationMin =
    s.sessionKind === 'run'
      ? estimateRunMinutes(s.targetDistanceKm, s.targetSessionType)
      : s.sessionKind === 'bike'
        ? bikeMinutes(s.targetDistanceKm)
        : LIFT_DURATION_MIN;

  const end = addMinutes(startHour, startMinute, durationMin);

  // Runs, and bikes given a distance (a hand-edited "— X km", MZY-262), carry
  // it in the title — lib/calendarReconcile.ts reads it back from there.
  const summary =
    s.sessionKind !== 'lift' && s.targetDistanceKm !== null
      ? `${emojiFor(s.sessionKind)} ${s.description} — ${s.targetDistanceKm} km`
      : `${emojiFor(s.sessionKind)} ${s.description}`;

  const routeEligible = s.sessionKind === 'run' || s.sessionKind === 'bike';
  return {
    summary,
    description: buildDescription(
      s,
      routeEligible ? opts.routes : undefined,
      routeEligible ? opts.adHocRoutes : undefined,
      startTimeNote(s, base),
      // Long-run Vaseline/refueling reminder is run-specific (distance-gated).
      s.sessionKind === 'run' ? opts.longRunFuelingInputs : undefined,
    ),
    start: {
      dateTime: localDateTime(s.date, startHour, startMinute),
      timeZone,
    },
    end: { dateTime: localDateTime(s.date, end.hour, end.minute), timeZone },
  };
}

const FUELING_EVENT_DURATION_MIN = 5;

/** The "HH:MM" time-of-day portion of a local datetime, in minutes since midnight. */
function timeOfDayMinutes(localDateTimeStr: string): number {
  const m = /T(\d{2}):(\d{2})/.exec(localDateTimeStr);
  if (!m) throw new Error(`unparseable local datetime: ${localDateTimeStr}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * A companion "🧃 Fueling" event at the midpoint of a run at/above
 * LONG_RUN_REMINDER_KM, dosed via estimateFuelingBottles (lib/fuelingCatalog.ts)
 * — one more bottle for every extra FUELING_BOTTLE_STEP_KM, so a longer run
 * always calls for at least as much as a shorter one instead of both capping at
 * the same amount. Null for a non-run session or a run below the threshold —
 * the caller (services/googleCalendar/sync.ts) takes down any previously-linked
 * fueling event in that case, since a program edit can drop a session below the
 * threshold after it already had one. Placed on the Agon Meals calendar rather
 * than Training, since this is consumption, not training load — mirrors where
 * the athlete asked for it (2026-09-07).
 */
export function mapRunToFuelingEvent(
  s: PlannedSessionForEvent,
  runEvent: CalendarEventInput,
): CalendarEventInput | null {
  if (s.sessionKind !== 'run' || s.targetDistanceKm === null) return null;
  const est = estimateFuelingBottles(s.targetDistanceKm);
  if (!est) return null;

  const startMin = timeOfDayMinutes(runEvent.start.dateTime);
  // A run ending after midnight reads as an earlier clock time; unwrap it.
  let endMin = timeOfDayMinutes(runEvent.end.dateTime);
  if (endMin < startMin) endMin += MINUTES_PER_DAY;
  const midMin = Math.round((startMin + endMin) / 2);
  const mid = { hour: Math.floor(midMin / 60), minute: midMin % 60 };
  const end = addMinutes(mid.hour, mid.minute, FUELING_EVENT_DURATION_MIN);
  const dateISO = runEvent.start.dateTime.slice(0, 10);

  const bottleWord = est.bottles === 1 ? 'bottle' : 'bottles';
  const description = [
    `Standard Fueling Solution ×${est.bottles} (${est.recipe} each): ` +
      `${est.kcal} kcal / ${est.carbsG} g carbs / ${est.sodiumMg} mg sodium.`,
    '',
    `Scheduled at the midpoint of today's ${s.targetDistanceKm} km run — ` +
      `${FUELING_BASE_BOTTLES} bottles at ${LONG_RUN_REMINDER_KM} km, one more every ` +
      `${FUELING_BOTTLE_STEP_KM} km beyond. ` +
      'Logged via run_fueling_items, not meal_logs.',
    '',
    'Planned by Agon',
  ]
    .map(htmlEscape)
    .join('<br>');

  return {
    summary: `🧃 Fueling — ${est.bottles} ${bottleWord}`,
    description,
    start: {
      dateTime: localDateTime(dateISO, mid.hour, mid.minute),
      timeZone: runEvent.start.timeZone,
    },
    end: {
      dateTime: localDateTime(dateISO, end.hour, end.minute),
      timeZone: runEvent.end.timeZone,
    },
  };
}

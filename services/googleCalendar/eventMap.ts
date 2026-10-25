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
} from '../../lib/constants';
import { getAthleteProfile } from '../../lib/athleteProfile';
import { commuteLegOf } from '../../lib/training/commutes';
import {
  defaultStart,
  effectiveStart,
  pad,
  sessionDurationMin,
  startTimeNote,
} from './eventSlots';

export {
  parseClockTime,
  estimateRunMinutes,
  startTimeNote,
  effectiveStart,
  effectiveStartTime,
} from './eventSlots';

// Pure mapping from a planned training session to a timed Google Calendar event.
// The slot and length come from ./eventSlots.ts (planned_sessions carries a date
// but no clock time). The description carries the full session detail — exercises
// (sets × reps) for lifts, interval structure for quality runs — from the static
// session library. Kept pure (no DB, no Date.now) so it's unit-tested directly
// and the sync layer only handles I/O.

export const DEFAULT_TIME_ZONE = 'Europe/Berlin'; // athlete is in Berlin
const HOME_ROUTES_HEADER = '🗺️ Suggested routes from home:';
const COMMUTE_ROUTES_HEADER = '🗺️ Commute routes:';

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
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape a URL for an href attribute value. */
function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

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
    renderRouteSection(html, HOME_ROUTES_HEADER, routes ?? []);
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
      const header = commuteLegOf(s.targetSessionType)
        ? COMMUTE_ROUTES_HEADER
        : HOME_ROUTES_HEADER;
      renderRouteSection(html, header, routes ?? []);
      renderRouteSection(html, '🧭 Ad hoc routes:', adHocRoutes ?? []);
    }
  }

  text('');
  text('Planned by Agon');
  return html.join('<br>');
}

/**
 * Map a planned session to a timed Calendar event. Runs start in the evening and
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

  const end = addMinutes(startHour, startMinute, sessionDurationMin(s));

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

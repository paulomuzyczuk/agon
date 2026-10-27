// Deciding what a Google Calendar event says about a planned session.
//
// The sync has always been one-way (DB → Calendar), so moving an event by hand
// was invisible to Agon and silently reverted on the next run. This is the other
// direction: given where a session thinks it is and where its event actually
// sits, work out what the athlete did.
//
// Pure (no DB, no network, no Date.now) so the conflict rules are unit-tested
// directly — they are the part that must not be got wrong, since a mistake here
// rewrites the athlete's calendar rather than merely failing.

import {
  descriptionToLines,
  extractAthleteDetail,
  resolvedDetailLines,
  sameDetail,
} from './calendarDetail';

/** What the DB currently believes about a session. */
export interface SessionState {
  /** Resolved date (plan + adjustment), YYYY-MM-DD. */
  date: string;
  /**
   * The local "HH:MM" the sync actually wrote this event at — an explicit strong
   * start time, else the default slot. Never null: comparing against the DB's
   * nullable start_time would make every move of a default-slot session invisible,
   * which is most of them.
   */
  startTime: string;
  /**
   * Run and bike events can carry a "— X km" distance suffix in their title (see
   * eventMap.ts's mapSessionToEvent); a lift's never counts as a distance.
   */
  sessionKind: 'run' | 'lift' | 'bike';
  /** Resolved target distance (plan + any existing adjustment), km. */
  targetDistanceKm: number | null;
  /**
   * Resolved description — the title text after the emoji. When given, a
   * hand-renamed title is read back (MZY-262, runs MZY-266). Omit to skip it.
   */
  description?: string;
  /** Resolved session type, to derive the program's default detail lines. */
  targetSessionType?: string | null;
  /** The detail override already stored for this session, if any. */
  detail?: string | null;
  /**
   * What Agon last pushed for this event, or null/absent when unknown (never
   * synced since the snapshot existed). Known → an unchanged event is never an
   * edit; unknown → fall back to comparing with the session's current values.
   */
  pushed?: PushedEvent | null;
}

/**
 * The event as Google held it right after Agon's last push (MZY-417). An event
 * that still equals this has not been touched by the athlete, whatever the
 * session's defaults say today.
 */
export interface PushedEvent {
  dateTime?: string;
  summary?: string;
  description?: string;
}

/** What the calendar says. `null` event means it is gone. */
export interface EventState {
  /** Event status; 'cancelled' is Google's tombstone for a deleted event. */
  status?: string;
  /** RFC-3339 local datetime ("2026-08-23T17:30:00+02:00"), for a timed event. */
  dateTime?: string;
  /** YYYY-MM-DD, for an all-day event. */
  date?: string;
  /** Event title, checked for a hand-edited "— X km" distance override. */
  summary?: string;
  /** Event description (HTML). Bike/lift: checked for hand-edited detail. */
  description?: string;
}

export interface ReconcileAction {
  /** Move the session to this date (null = date unchanged). */
  date: string | null;
  /** Move the session to this local start time (null = time unchanged). */
  startTime: string | null;
  /**
   * Persist this as the session's new target distance, km (null = unchanged).
   * The athlete hand-edited the "— X km" suffix directly in Google Calendar —
   * the "hand edits win" rule (CLAUDE.md) means this overrides the program's
   * value, not the other way around.
   */
  targetDistanceKm: number | null;
  /** Persist as the session's new description (hand-renamed title), or null. */
  description: string | null;
  /** Persist as the session's detail override (bike/lift), or null. */
  detail: string | null;
  /** The athlete deleted the event: the session is not happening. */
  skip: boolean;
  /** Human-readable summary of what changed, for logs and the adjustment note. */
  reason: string | null;
}

const NO_CHANGE: ReconcileAction = {
  date: null,
  startTime: null,
  targetDistanceKm: null,
  description: null,
  detail: null,
  skip: false,
  reason: null,
};

/**
 * Parse a hand-edited distance out of an event title's trailing "— X km"
 * (mirrors the suffix mapSessionToEvent appends for runs in eventMap.ts — keep
 * the two in sync). Returns null when absent/unparseable/non-positive, never a
 * guess: no suffix means "leave the distance alone", not "clear it".
 *
 * Accepts a decimal comma ("21,2 km") as well as a dot: the athlete types in a
 * de/pt locale, and an unparsed edit reads as "no edit" — which lets the push
 * overwrite it with the program value (MZY-259).
 */
function parseTitleDistanceKm(summary: string | undefined): number | null {
  if (!summary) return null;
  const m = /—\s*(\d+(?:[.,]\d+)?)\s*km\s*$/.exec(summary.trim());
  if (!m) return null;
  const n = Number((m[1] ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The new distance to persist, or null when the title carries none / matches. */
function detectDistanceEdit(
  session: SessionState,
  event: EventState,
): number | null {
  if (session.sessionKind === 'lift') return null;
  const titleKm = parseTitleDistanceKm(event.summary);
  if (titleKm === null) return null;
  return titleKm === session.targetDistanceKm ? null : titleKm;
}

/** Join changed-thing fragments into one reason string, or null if none. */
function buildReason(fragments: string[]): string | null {
  return fragments.length > 0
    ? `${fragments.join(', ')} in Google Calendar`
    : null;
}

/**
 * Split an RFC-3339 local datetime into its calendar day and wall clock, WITHOUT
 * converting to UTC. Google returns the event's own local time plus its offset;
 * reading the leading characters keeps "17:30 in Berlin" as 17:30 rather than
 * shifting it into whatever zone this process happens to run in.
 */
export function splitLocalDateTime(
  dateTime: string,
): { date: string; time: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(dateTime);
  return m ? { date: m[1]!, time: `${m[2]}:${m[3]}` } : null;
}

const TITLE_KM_SUFFIX = /\s*—\s*\d+(?:[.,]\d+)?\s*km\s*$/;

/**
 * A title renamed by hand: the text after the emoji (and, for a run or bike,
 * before any "— X km"), when it differs from the resolved description. Null when
 * unchanged, empty, or not checkable. Runs included since MZY-266 — without it a
 * renamed run ("Half-Marathon") was pushed back to the program's name.
 */
function detectTitleEdit(
  session: SessionState,
  event: EventState,
): string | null {
  if (session.description === undefined) return null;
  if (!event.summary) return null;
  let text = event.summary.trim().replace(/^[^\p{L}\p{N}]+/u, '');
  if (session.sessionKind !== 'lift') text = text.replace(TITLE_KM_SUFFIX, '');
  text = text.trim();
  return text === '' || text === session.description ? null : text;
}

/**
 * A bike/lift description detail rewritten by hand: the athlete-authored lines
 * (see lib/calendarDetail.ts), when they differ from what the event renders now.
 * An emptied detail is not an edit — never clear on a guess.
 */
function detectDetailEdit(
  session: SessionState,
  event: EventState,
): string | null {
  if (session.sessionKind === 'run' || event.description === undefined) {
    return null;
  }
  const athlete = extractAthleteDetail(descriptionToLines(event.description));
  if (athlete.every((l) => l === '')) return null;
  const current = resolvedDetailLines(
    session.sessionKind,
    session.targetSessionType ?? null,
    session.detail,
  );
  return sameDetail(athlete, current) ? null : athlete.join('\n');
}

interface ContentEdit {
  targetDistanceKm: number | null;
  description: string | null;
  detail: string | null;
  fragments: string[];
}

/** True when the event's title and description are exactly what Agon pushed. */
function contentUntouched(session: SessionState, event: EventState): boolean {
  const p = session.pushed;
  return (
    !!p &&
    p.summary !== undefined &&
    p.summary === event.summary &&
    p.description === event.description
  );
}

/** True when the event still sits where Agon put it. */
function timeUntouched(session: SessionState, event: EventState): boolean {
  const pushed = session.pushed?.dateTime;
  if (!pushed || !event.dateTime) return false;
  const a = splitLocalDateTime(pushed);
  const b = splitLocalDateTime(event.dateTime);
  return !!a && !!b && a.date === b.date && a.time === b.time;
}

function detectContentEdits(
  session: SessionState,
  event: EventState,
): ContentEdit {
  if (contentUntouched(session, event)) {
    return {
      targetDistanceKm: null,
      description: null,
      detail: null,
      fragments: [],
    };
  }
  const targetDistanceKm = detectDistanceEdit(session, event);
  const description = detectTitleEdit(session, event);
  const detail = detectDetailEdit(session, event);
  const fragments = [
    ...(description !== null ? [`title edited to "${description}"`] : []),
    ...(targetDistanceKm !== null
      ? [`distance edited to ${targetDistanceKm} km`]
      : []),
    ...(detail !== null ? ['details edited'] : []),
  ];
  return { targetDistanceKm, description, detail, fragments };
}

/**
 * What to do about one session given its event.
 *
 * Conflict rule: the CALENDAR wins for date and time, because moving an event is
 * a deliberate act by the athlete and the calendar is what they actually read.
 * Content follows the same "hand edits win" rule where the event can express it:
 * a run's or ride's "— X km", any session's title (runs since MZY-266), and a
 * ride's or lift's detail lines (MZY-262). What it can't express — HR cap, session type, routes Agon
 * generated — stays Agon's.
 *
 * A deleted event maps to `skip` rather than a date change: absence is a
 * statement about whether the session happens, not about when.
 */
export function reconcileSession(
  session: SessionState,
  event: EventState | null,
): ReconcileAction {
  if (!event || event.status === 'cancelled') {
    return {
      ...NO_CHANGE,
      skip: true,
      reason: 'event deleted in Google Calendar',
    };
  }

  const content = detectContentEdits(session, event);
  const withContent = (
    date: string | null,
    startTime: string | null,
    moveFragments: string[],
  ): ReconcileAction => {
    const fragments = [...moveFragments, ...content.fragments];
    if (fragments.length === 0) return NO_CHANGE;
    return {
      date,
      startTime,
      targetDistanceKm: content.targetDistanceKm,
      description: content.description,
      detail: content.detail,
      skip: false,
      reason: buildReason(fragments),
    };
  };

  // All-day: the athlete stripped the time. Honour the day, and deliberately
  // leave startTime alone — clearing it would silently drop a 05:45 heat start
  // that the program, not the calendar, is the authority on.
  if (event.date && !event.dateTime) {
    const dateMoved = event.date !== session.date;
    return withContent(
      dateMoved ? event.date : null,
      null,
      dateMoved ? [`moved to ${event.date}`] : [],
    );
  }

  // Nothing usable (or unparseable) for date/time — never guess at the
  // athlete's calendar there; content edits are independent and still stand.
  const split = event.dateTime ? splitLocalDateTime(event.dateTime) : null;
  if (!split) return withContent(null, null, []);

  // Where Agon left it is not a move, even if today's default slot differs
  // (MZY-417: a changed default must never read as a hand edit).
  if (timeUntouched(session, event)) return withContent(null, null, []);

  const dateMoved = split.date !== session.date;
  // A session with no explicit start time sits in the sync's default slot; the
  // event's time only counts as a MOVE once it differs from what we set.
  const timeMoved =
    session.startTime !== null && split.time !== session.startTime;

  const parts: string[] = [];
  if (dateMoved) parts.push(`to ${split.date}`);
  if (timeMoved) parts.push(`to ${split.time}`);
  return withContent(
    dateMoved ? split.date : null,
    timeMoved ? split.time : null,
    parts.length > 0 ? [`moved ${parts.join(' ')}`] : [],
  );
}

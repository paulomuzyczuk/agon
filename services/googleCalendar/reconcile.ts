import { logger } from '../logger';
import {
  getLinkedSessions,
  setSessionStatus,
  type CalendarSyncRow,
} from '../plannedSessions';
import { mergeCalendarAdjustment } from '../sessionAdjustments';
import { query } from '../db';
import { getValidAccessToken } from './oauth';
import { ensureCalendar } from './calendars';
import { listEvents } from './client';
import { effectiveStartTime } from './eventMap';
import { reconcileSession, type EventState } from '../../lib/calendarReconcile';
import type { EventResource } from './types';

// Read the Training calendar and write what the athlete DID back into the
// adjustment overlay — the other half of the sync, and the thing that makes
// "the calendar is my reality" true rather than aspirational.
//
// Everything it writes lands in session_adjustments or planned_sessions.status.
// It NEVER edits the program columns, so a drag in Google Calendar reschedules a
// session without damaging the plan it came from.

export interface ReconcileSummary {
  /** Sessions examined (those already linked to an event). */
  examined: number;
  /** Sessions whose date and/or time moved on the calendar. */
  moved: number;
  /** Sessions whose event the athlete deleted, now marked skipped. */
  skipped: number;
  /** Sessions whose title distance was hand-edited on the calendar. */
  distanceChanged: number;
  /** Bike/lift sessions whose title or detail was hand-edited (MZY-262). */
  contentChanged: number;
}

/** I/O seams so the orchestration is unit-testable with no Google and no DB. */
export interface ReconcileDeps {
  getAccessToken: () => Promise<string>;
  ensureTrainingCalendar: (token: string) => Promise<string>;
  /**
   * Linked sessions to examine: those resolved on/after `fromISO`, plus any whose
   * event id is in `eventIds` (events found in the window) regardless of DB date.
   */
  getSessions: (
    fromISO: string,
    eventIds: string[],
  ) => Promise<CalendarSyncRow[]>;
  fetchEvents: (
    token: string,
    calendarId: string,
    timeMin: string,
  ) => Promise<EventResource[]>;
  /** `editedAt`: the event's `updated` — when the athlete made the edit (the merge's clock). */
  recordMove: (
    sessionId: string,
    patch: { date?: string; note: string },
    editedAt?: string,
  ) => Promise<void>;
  recordSkip: (sessionId: string) => Promise<void>;
  recordTime: (sessionId: string, startTime: string) => Promise<void>;
  /** Persist a hand-edited title distance as a 'calendar'-sourced adjustment. */
  recordDistance: (
    sessionId: string,
    targetDistanceKm: number,
    note: string,
    editedAt?: string,
  ) => Promise<void>;
  /** Persist a hand-edited bike/lift title and/or detail (MZY-262). */
  recordContent: (
    sessionId: string,
    patch: { description?: string; detail?: string },
    note: string,
    editedAt?: string,
  ) => Promise<void>;
}

/** Every event from `timeMin` on, following pagination. */
async function fetchAllEvents(
  token: string,
  calendarId: string,
  timeMin: string,
): Promise<EventResource[]> {
  const all: EventResource[] = [];
  let pageToken: string | undefined;
  // Bounded so a paging bug can't spin forever; 20 × 250 is far more than a
  // season of training events.
  for (let page = 0; page < 20; page++) {
    const res = await listEvents(token, calendarId, { timeMin, pageToken });
    all.push(...res.items);
    pageToken = res.nextPageToken;
    if (!pageToken) break;
  }
  return all;
}

const defaultDeps: ReconcileDeps = {
  getAccessToken: () => getValidAccessToken(),
  ensureTrainingCalendar: (token) => ensureCalendar(token, 'training'),
  getSessions: (fromISO, eventIds) => getLinkedSessions(fromISO, eventIds),
  fetchEvents: (token, calendarId, timeMin) =>
    fetchAllEvents(token, calendarId, timeMin),
  // Calendar is a human-origin sync peer (MZY-208): its edits go through the
  // same mergeField() as every device, stamped with when the event was edited.
  recordMove: async (sessionId, patch, editedAt) => {
    await mergeCalendarAdjustment(sessionId, patch, editedAt);
  },
  recordSkip: (sessionId) => setSessionStatus(sessionId, 'skipped'),
  // A calendar move is by definition a 'strong' one — the athlete physically put
  // the event there, so the sync must not drag it back to the default slot.
  recordTime: async (sessionId, startTime) => {
    await query(
      `UPDATE public.planned_sessions
          SET start_time = $2::time,
              start_time_priority = 'strong',
              start_time_reason = $3
        WHERE id = $1`,
      [sessionId, startTime, 'moved in Google Calendar'],
    );
  },
  recordDistance: async (sessionId, targetDistanceKm, note, editedAt) => {
    await mergeCalendarAdjustment(
      sessionId,
      { targetDistanceKm, note },
      editedAt,
    );
  },
  recordContent: async (sessionId, patch, note, editedAt) => {
    await mergeCalendarAdjustment(sessionId, { ...patch, note }, editedAt);
  },
};

export interface ReconcileOptions {
  /** Only look at sessions on/after this date (default: caller supplies today). */
  fromISO: string;
  /** Report what would change without writing anything. */
  dryRun?: boolean;
}

export async function reconcileFromCalendar(
  opts: ReconcileOptions,
  deps: ReconcileDeps = defaultDeps,
): Promise<ReconcileSummary> {
  const token = await deps.getAccessToken();
  const calendarId = await deps.ensureTrainingCalendar(token);

  // One list call for the whole window, then a local lookup — a per-session GET
  // would be one request each and would 404-storm on hand-deleted events.
  const events = await deps.fetchEvents(
    token,
    calendarId,
    `${opts.fromISO}T00:00:00Z`,
  );
  const byId = new Map(events.map((e) => [e.id, e]));
  // Window by the EVENT as well as by Agon's date: a session dragged forward in
  // Calendar from before `fromISO` into the window still has its old date in the
  // DB, and filtering on that alone would never see the drag or any edit made
  // to it (MZY-259).
  const sessions = await deps.getSessions(opts.fromISO, [...byId.keys()]);

  let moved = 0;
  let skipped = 0;
  let distanceChanged = 0;
  let contentChanged = 0;

  for (const s of sessions) {
    if (!s.gcalEventId) continue;
    const event = byId.get(s.gcalEventId);
    const state: EventState | null = event
      ? {
          status: event.status,
          dateTime: event.start?.dateTime,
          date: event.start?.date,
          summary: event.summary,
          description: event.description,
        }
      : null;

    const action = reconcileSession(
      {
        date: s.date,
        startTime: effectiveStartTime(s),
        sessionKind: s.sessionKind,
        targetDistanceKm: s.targetDistanceKm,
        description: s.description,
        targetSessionType: s.targetSessionType,
        detail: s.detail ?? null,
      },
      state,
    );
    if (
      !action.skip &&
      action.date === null &&
      action.startTime === null &&
      action.targetDistanceKm === null &&
      action.description === null &&
      action.detail === null
    ) {
      continue;
    }

    if (action.skip) {
      skipped++;
      logger.info('session skipped from calendar', {
        job: 'google-calendar-reconcile',
        sessionId: s.id,
        date: s.date,
      });
      if (!opts.dryRun) await deps.recordSkip(s.id);
      continue;
    }

    if (action.targetDistanceKm !== null) distanceChanged++;
    if (action.description !== null || action.detail !== null) {
      contentChanged++;
    }
    if (action.date !== null || action.startTime !== null) moved++;
    logger.info('session moved on calendar', {
      job: 'google-calendar-reconcile',
      sessionId: s.id,
      from: s.date,
      to: action.date ?? s.date,
      targetDistanceKm: action.targetDistanceKm ?? undefined,
      reason: action.reason ?? '',
    });
    if (opts.dryRun) continue;

    // A time-only move rewrites the note too: the LAST move wins. Otherwise a
    // session dragged twice (date + 14:00, then to 23:15) keeps saying "to 14:00"
    // while start_time and the event already sit at 23:15.
    if (action.date || action.startTime) {
      await deps.recordMove(
        s.id,
        {
          ...(action.date ? { date: action.date } : {}),
          note: action.reason ?? 'moved in Google Calendar',
        },
        event?.updated,
      );
    }
    if (action.startTime) await deps.recordTime(s.id, action.startTime);
    if (action.targetDistanceKm !== null) {
      await deps.recordDistance(
        s.id,
        action.targetDistanceKm,
        action.reason ?? 'distance edited in Google Calendar',
        event?.updated,
      );
    }
    if (action.description !== null || action.detail !== null) {
      await deps.recordContent(
        s.id,
        {
          ...(action.description !== null
            ? { description: action.description }
            : {}),
          ...(action.detail !== null ? { detail: action.detail } : {}),
        },
        action.reason ?? 'edited in Google Calendar',
        event?.updated,
      );
    }
  }

  const summary: ReconcileSummary = {
    examined: sessions.length,
    moved,
    skipped,
    distanceChanged,
    contentChanged,
  };
  logger.info('calendar reconcile complete', {
    job: 'google-calendar-reconcile',
    ...summary,
    dryRun: opts.dryRun ?? false,
  });
  return summary;
}

/** One-line human summary for CLI output. */
export function describeReconcileSummary(
  s: ReconcileSummary,
  dryRun: boolean,
): string {
  const prefix = dryRun ? 'Would reconcile' : 'Reconciled';
  const distance =
    s.distanceChanged > 0 ? `, ${s.distanceChanged} distance edited` : '';
  const content =
    s.contentChanged > 0 ? `, ${s.contentChanged} title/detail edited` : '';
  return `${prefix} — ${s.moved} moved, ${s.skipped} skipped${distance}${content} (${s.examined} linked session(s)).`;
}

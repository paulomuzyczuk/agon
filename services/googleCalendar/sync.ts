import { logger } from '../logger';
import {
  getSessionsToSync,
  getSkippedSessionsWithEvents,
  markSessionSynced,
  clearSessionEventLink,
  markFuelingEventSynced,
  clearFuelingEventLink,
  type CalendarSyncRow,
  type SkippedSessionEvent,
} from '../plannedSessions';
import { getValidAccessToken } from './oauth';
import { ensureCalendar } from './calendars';
import {
  insertEvent,
  patchEvent,
  deleteEvent,
  GoogleCalendarNotFoundError,
} from './client';
import {
  mapSessionToEvent,
  mapRunToFuelingEvent,
  DEFAULT_TIME_ZONE,
} from './eventMap';
import {
  ensureRoutesForSession,
  attachedRouteToEventInfo,
} from './routeForSession';
import { getAttachedRoutes } from '../routeSuggestions';
import { OrsRateLimitError } from '../routing';
import { reconcileFromCalendar, type ReconcileSummary } from './reconcile';
import type { EventRouteInfo } from './eventMap';
import type { CalendarEventInput, EventResource } from './types';
import { getBaselineSweatRate } from '../sweat';
import { recentAveragePaceSPerKm } from '../nutritionGoals';
import { DEFAULT_EASY_PACE_S_PER_KM } from '../../lib/constants';

// Push planned training sessions to the dedicated "Agon Training" calendar,
// idempotent via planned_sessions.gcal_event_id: a session with no linked event
// is inserted; one already linked is patched (so program edits propagate). A
// patch that 404s (event deleted on the Google side) falls back to a fresh
// insert. The "Agon Meals" calendar is also ensured (created empty) so both
// calendars exist after the first sync, per the two-calendar design.

export interface CalendarSyncSummary {
  calendarId: string;
  created: number;
  updated: number;
  total: number;
  /** Run/bike events that carried a suggested route link in their description. */
  routesAttached: number;
  /**
   * Events taken down: a session's main event or companion fueling event when
   * marked skipped, plus a stale fueling event when a program edit drops a
   * run's distance back below LONG_RUN_REMINDER_KM.
   */
  removed: number;
  /** Companion "🧃 Fueling" events created (Agon Meals calendar). */
  fuelingCreated: number;
  /** Companion "🧃 Fueling" events patched (already linked). */
  fuelingUpdated: number;
  /** Result of the pre-sync reconcile pass, or null when it wasn't run. */
  reconciled: ReconcileSummary | null;
}

/** I/O seams so the sync is unit-testable without Google or a DB. */
export interface CalendarSyncDeps {
  getAccessToken: () => Promise<string>;
  ensureTrainingCalendar: (token: string) => Promise<string>;
  ensureMealsCalendar: (token: string) => Promise<string>;
  getSessions: (fromISO: string) => Promise<CalendarSyncRow[]>;
  insert: (
    token: string,
    calendarId: string,
    event: CalendarEventInput,
  ) => Promise<EventResource>;
  patch: (
    token: string,
    calendarId: string,
    eventId: string,
    event: CalendarEventInput,
  ) => Promise<EventResource>;
  markSynced: (id: string, eventId: string) => Promise<void>;
  /** Record a session's linked companion fueling event id. */
  markFuelingSynced: (id: string, eventId: string) => Promise<void>;
  /** Forget a session's fueling-event link (event deleted or no longer qualifies). */
  unlinkFueling: (id: string) => Promise<void>;
  /** Suggested (auto) routes for a run/bike session ([] when N/A). Failures degrade to []. */
  resolveRoutes: (session: CalendarSyncRow) => Promise<EventRouteInfo[]>;
  /** Ad-hoc routes already attached to a session (never generated here). */
  getAdHocRoutes: (session: CalendarSyncRow) => Promise<EventRouteInfo[]>;
  /** Skipped sessions whose calendar event still needs taking down. */
  getSkipped: (fromISO: string) => Promise<SkippedSessionEvent[]>;
  /** Remove an event from the calendar (already 404-tolerant). */
  remove: (token: string, calendarId: string, eventId: string) => Promise<void>;
  /** Forget the deleted event's id so the session no longer points at it. */
  unlink: (id: string) => Promise<void>;
  /** Pull the athlete's own calendar edits back in before pushing (opt-in). */
  reconcile: (fromISO: string) => Promise<ReconcileSummary>;
  /**
   * Athlete's current pace/sweat-rate for the long-run Vaseline/refueling
   * reminder — resolved ONCE per sync (athlete-wide, not session-specific),
   * unlike routes. Null degrades to skipping the reminder, never fails the sync.
   */
  getFuelingInputs: () => Promise<{
    paceSPerKm: number;
    sweatRateLPerH: number;
  } | null>;
}

const defaultDeps: CalendarSyncDeps = {
  getAccessToken: () => getValidAccessToken(),
  ensureTrainingCalendar: (token) => ensureCalendar(token, 'training'),
  ensureMealsCalendar: (token) => ensureCalendar(token, 'meals'),
  getSessions: (fromISO) => getSessionsToSync(fromISO),
  insert: (token, calendarId, event) => insertEvent(token, calendarId, event),
  patch: (token, calendarId, eventId, event) =>
    patchEvent(token, calendarId, eventId, event),
  markSynced: (id, eventId) => markSessionSynced(id, eventId),
  markFuelingSynced: (id, eventId) => markFuelingEventSynced(id, eventId),
  unlinkFueling: (id) => clearFuelingEventLink(id),
  // A routing failure (no ORS key, geocode miss) must NOT fail the calendar sync —
  // the event still syncs, just without route links. A rate-limit error is
  // rethrown so the sync loop can short-circuit the remaining sessions (no point
  // hammering ORS once the per-minute quota is spent; they fill in next sync).
  resolveRoutes: async (session) => {
    try {
      return await ensureRoutesForSession(session);
    } catch (err) {
      if (err instanceof OrsRateLimitError) throw err;
      logger.warn('route suggestions skipped for session', {
        job: 'google-calendar-sync',
        sessionId: session.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  },
  getAdHocRoutes: async (session) => {
    const rows = await getAttachedRoutes(session.id, 'adhoc');
    return rows.map(attachedRouteToEventInfo);
  },
  getSkipped: (fromISO) => getSkippedSessionsWithEvents(fromISO),
  // Resolves its own token and calendar rather than taking ours: the two passes
  // stay independently runnable (`pnpm gcal:reconcile`), and the extra call is a
  // cached-token no-op next to the event round-trips either way.
  reconcile: (fromISO) => reconcileFromCalendar({ fromISO }),
  remove: (token, calendarId, eventId) =>
    deleteEvent(token, calendarId, eventId),
  unlink: (id) => clearSessionEventLink(id),
  // A failure here (e.g. DB hiccup) must not fail the whole sync — the reminder
  // just doesn't render, same degrade-gracefully posture as resolveRoutes.
  getFuelingInputs: async () => {
    try {
      const sweatRateLPerH = await getBaselineSweatRate();
      const paceSPerKm =
        (await recentAveragePaceSPerKm()) ?? DEFAULT_EASY_PACE_S_PER_KM;
      return { paceSPerKm, sweatRateLPerH };
    } catch (err) {
      logger.warn('long-run fueling inputs unavailable — skipping reminder', {
        job: 'google-calendar-sync',
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  },
};

/** Today as YYYY-MM-DD (default sync floor — future sessions only). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface CalendarSyncOptions {
  fromISO?: string;
  timeZone?: string;
  /** Attach suggested route links to run/bike events (default true). */
  routes?: boolean;
  /**
   * Pull the athlete's calendar edits back into Agon BEFORE pushing (default
   * false). Opt-in because it writes: a moved event becomes an adjustment, a
   * deleted one marks the session skipped.
   */
  reconcile?: boolean;
}

export async function syncTrainingCalendar(
  opts: CalendarSyncOptions = {},
  deps: CalendarSyncDeps = defaultDeps,
): Promise<CalendarSyncSummary> {
  const fromISO = opts.fromISO ?? todayISO();
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;

  const token = await deps.getAccessToken();
  // Ensure both dedicated calendars exist. Meals hosts the standing meal-slot
  // events (scripts/sync-meal-calendar.ts) plus the companion "🧃 Fueling"
  // events this sync creates below.
  const mealsCalendarId = await deps.ensureMealsCalendar(token);
  const calendarId = await deps.ensureTrainingCalendar(token);

  // Reconcile FIRST, always. Pushing before reading would overwrite the athlete's
  // own edits with Agon's stale view — the precise failure the reconcile pass
  // exists to end — so the ordering is enforced here rather than left to whoever
  // remembers to run two commands in the right order.
  const reconciled = opts.reconcile ? await deps.reconcile(fromISO) : null;

  const withRoutes = opts.routes !== false;
  // Read sessions AFTER reconciling, so a session just moved or skipped syncs
  // from its new state instead of being pushed back to where it was.
  const sessions = await deps.getSessions(fromISO);
  // Athlete-wide, not session-specific — resolved once for the whole sync
  // (unlike routes, which are per-session).
  const fuelingInputs = await deps.getFuelingInputs();
  let created = 0;
  let updated = 0;
  let routesAttached = 0;
  let fuelingCreated = 0;
  let fuelingUpdated = 0;
  let removed = 0;
  let routeRateLimited = false; // once ORS 429s, stop attempting routes this sync

  for (const s of sessions) {
    let routes: EventRouteInfo[] = [];
    if (withRoutes && !routeRateLimited) {
      try {
        routes = await deps.resolveRoutes(s);
      } catch (err) {
        if (!(err instanceof OrsRateLimitError)) throw err;
        routeRateLimited = true;
        logger.warn(
          'ORS rate limit — skipping remaining route links this sync',
          {
            job: 'google-calendar-sync',
          },
        );
      }
    }
    if (routes.length > 0) routesAttached++;
    // Ad-hoc routes are always fetched (cheap DB read) so re-syncs preserve the
    // "🧭 Ad hoc routes" section rather than overwriting it.
    const adHocRoutes = withRoutes ? await deps.getAdHocRoutes(s) : [];
    const event = mapSessionToEvent(s, {
      timeZone,
      routes,
      adHocRoutes,
      longRunFuelingInputs: fuelingInputs,
    });

    let mainEventSynced = false;
    if (s.gcalEventId) {
      try {
        await deps.patch(token, calendarId, s.gcalEventId, event);
        updated++;
        mainEventSynced = true;
      } catch (err) {
        if (!(err instanceof GoogleCalendarNotFoundError)) throw err;
        // Event was deleted on the calendar side — recreate it below.
      }
    }
    if (!mainEventSynced) {
      const res = await deps.insert(token, calendarId, event);
      await deps.markSynced(s.id, res.id);
      created++;
    }

    // Companion "🧃 Fueling" event, on the Agon Meals calendar — mirrors the
    // same insert-vs-patch idempotency as the main event above. Null below
    // LONG_RUN_REMINDER_KM (or for a non-run session); a session that drops
    // below the threshold after already having one gets that stale event
    // removed instead, rather than left stranded on the calendar.
    const fuelingEvent = mapRunToFuelingEvent(s, event);
    if (fuelingEvent) {
      let fuelingSynced = false;
      if (s.gcalFuelingEventId) {
        try {
          await deps.patch(
            token,
            mealsCalendarId,
            s.gcalFuelingEventId,
            fuelingEvent,
          );
          fuelingUpdated++;
          fuelingSynced = true;
        } catch (err) {
          if (!(err instanceof GoogleCalendarNotFoundError)) throw err;
          // Fueling event was deleted on the calendar side — recreate below.
        }
      }
      if (!fuelingSynced) {
        const res = await deps.insert(token, mealsCalendarId, fuelingEvent);
        await deps.markFuelingSynced(s.id, res.id);
        fuelingCreated++;
      }
    } else if (s.gcalFuelingEventId) {
      await deps.remove(token, mealsCalendarId, s.gcalFuelingEventId);
      await deps.unlinkFueling(s.id);
      removed++;
    }
  }

  // Take down events for sessions the athlete has marked skipped. These are
  // invisible to the loop above (getSessionsToSync filters them out), so without
  // this pass a session skipped after its event was created would keep that event
  // (and any companion fueling event) on the calendar forever.
  for (const skipped of await deps.getSkipped(fromISO)) {
    if (skipped.gcalEventId) {
      await deps.remove(token, calendarId, skipped.gcalEventId);
      await deps.unlink(skipped.id);
      removed++;
    }
    if (skipped.gcalFuelingEventId) {
      await deps.remove(token, mealsCalendarId, skipped.gcalFuelingEventId);
      await deps.unlinkFueling(skipped.id);
      removed++;
    }
    if (skipped.gcalEventId || skipped.gcalFuelingEventId) {
      logger.info('removed event(s) for skipped session', {
        job: 'google-calendar-sync',
        sessionId: skipped.id,
        date: skipped.date,
      });
    }
  }

  const summary: CalendarSyncSummary = {
    calendarId,
    created,
    updated,
    total: sessions.length,
    routesAttached,
    removed,
    fuelingCreated,
    fuelingUpdated,
    reconciled,
  };
  logger.info('training calendar synced', {
    job: 'google-calendar-sync',
    ...summary,
    fromISO,
  });
  return summary;
}

/** One-line human summary for CLI / Telegram output. */
export function describeCalendarSyncSummary(s: CalendarSyncSummary): string {
  const routes = s.routesAttached > 0 ? `, ${s.routesAttached} route(s)` : '';
  const removed = s.removed > 0 ? `, ${s.removed} removed` : '';
  const fueling =
    s.fuelingCreated > 0 || s.fuelingUpdated > 0
      ? `, ${s.fuelingCreated} fueling created / ${s.fuelingUpdated} updated`
      : '';
  const line = `Calendar synced — ${s.created} created, ${s.updated} updated${removed}${routes}${fueling} (${s.total} session(s)).`;
  if (!s.reconciled) return line;
  const { moved, skipped } = s.reconciled;
  return `Reconciled from Calendar — ${moved} moved, ${skipped} skipped.\n${line}`;
}

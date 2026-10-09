import { getValidAccessToken } from './oauth';
import { ensureCalendar } from './calendars';
import { insertEvent, patchEvent, GoogleCalendarNotFoundError } from './client';
import { mapSessionToEvent, type EventRouteInfo } from './eventMap';
import { markSessionSynced, type CalendarSyncRow } from '../plannedSessions';

// Upsert ONE session's Training-calendar event (insert if unlinked, patch if
// linked, re-insert on a 404). Used by the ad-hoc /route path to reflect a new
// route on the calendar immediately, without waiting for the next gcal:sync. The
// per-session insert/patch logic mirrors sync.ts.

export interface SessionEventRoutes {
  routes: EventRouteInfo[];
  adHocRoutes: EventRouteInfo[];
}

export async function upsertSessionEvent(
  session: CalendarSyncRow,
  routes: SessionEventRoutes,
): Promise<void> {
  const token = await getValidAccessToken();
  const calendarId = await ensureCalendar(token, 'training');
  const event = mapSessionToEvent(session, {
    routes: routes.routes,
    adHocRoutes: routes.adHocRoutes,
  });

  if (session.gcalEventId) {
    try {
      await patchEvent(token, calendarId, session.gcalEventId, event);
      return;
    } catch (err) {
      if (!(err instanceof GoogleCalendarNotFoundError)) throw err;
      // Event was deleted on the calendar side — recreate it below.
    }
  }
  const res = await insertEvent(token, calendarId, event);
  await markSessionSynced(session.id, res.id);
}

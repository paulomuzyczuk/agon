import { z } from 'zod';
import {
  calendarResourceSchema,
  eventResourceSchema,
  type CalendarResource,
  type CalendarEventInput,
  type EventResource,
} from './types';

// Authenticated Google Calendar API v3 client. Mirrors the fetch/auth/error
// shape of services/googleHealth/client.ts (Bearer token, 429 → dedicated error
// class, non-2xx → thrown Error with body). Callers pass a fresh access token
// from oauth.getValidAccessToken().

const API_BASE = 'https://www.googleapis.com/calendar/v3';

export class GoogleCalendarRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleCalendarRateLimitError';
  }
}

/**
 * Raised when the event isn't there — 404 (never existed / not visible) or 410
 * Gone (Google's answer for a resource already deleted, which is what a DELETE of
 * an event the athlete removed by hand returns). Both mean "no such event", so
 * the sync can tell that apart from a real failure.
 */
export class GoogleCalendarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleCalendarNotFoundError';
  }
}

function rateLimited(res: Response): boolean {
  return res.status === 429 || res.status === 403; // 403 also covers usage limits
}

async function gcFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 404 || res.status === 410) {
    throw new GoogleCalendarNotFoundError(
      `google-calendar: ${init?.method ?? 'GET'} ${path} returned ${res.status}`,
    );
  }
  if (rateLimited(res)) {
    const text = await res.text().catch(() => '');
    throw new GoogleCalendarRateLimitError(
      `google-calendar: rate/usage limit on ${path} (HTTP ${res.status}) ${text}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `google-calendar: ${init?.method ?? 'GET'} ${path} failed (${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res;
}

/** Create a new secondary calendar; returns its resource (with the minted id). */
export async function insertCalendar(
  accessToken: string,
  input: { summary: string; description?: string; timeZone?: string },
): Promise<CalendarResource> {
  const res = await gcFetch('/calendars', accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return calendarResourceSchema.parse(await res.json());
}

/** Fetch a calendar by id — used to verify a stored calendar still exists. */
export async function getCalendar(
  accessToken: string,
  calendarId: string,
): Promise<CalendarResource> {
  const res = await gcFetch(
    `/calendars/${encodeURIComponent(calendarId)}`,
    accessToken,
  );
  return calendarResourceSchema.parse(await res.json());
}

/**
 * Set a calendar's color in the user's calendar list (background + foreground
 * hex). Color is a per-user calendarList property, not a calendar property, so
 * it's a PATCH on users/me/calendarList with colorRgbFormat=true. Idempotent.
 */
export async function setCalendarColor(
  accessToken: string,
  calendarId: string,
  backgroundColor: string,
  foregroundColor: string,
): Promise<void> {
  await gcFetch(
    `/users/me/calendarList/${encodeURIComponent(calendarId)}?colorRgbFormat=true`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ backgroundColor, foregroundColor }),
    },
  );
}

/** Insert an event into a calendar; returns the created event (with its id). */
export async function insertEvent(
  accessToken: string,
  calendarId: string,
  event: CalendarEventInput,
): Promise<EventResource> {
  const res = await gcFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    accessToken,
    { method: 'POST', body: JSON.stringify(event) },
  );
  return eventResourceSchema.parse(await res.json());
}

/**
 * Patch an existing event (partial update). Throws GoogleCalendarNotFoundError
 * if the event was deleted on the calendar side, so the sync can re-insert.
 */
export async function patchEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  event: CalendarEventInput,
): Promise<EventResource> {
  const res = await gcFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(event) },
  );
  return eventResourceSchema.parse(await res.json());
}

/** Delete an event. Swallows 404 (already gone) so deletes are idempotent. */
export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await gcFetch(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      accessToken,
      { method: 'DELETE' },
    );
  } catch (err) {
    if (err instanceof GoogleCalendarNotFoundError) return;
    throw err;
  }
}

/** One page of events on a calendar, for the reconcile pass. */
export interface ListEventsPage {
  items: EventResource[];
  nextPageToken?: string;
}

/**
 * Events on a calendar from `timeMin` onward, newest last. `showDeleted` is on so
 * the reconcile pass can SEE a cancelled event: an event the athlete deleted is
 * the strongest possible statement that the session isn't happening, and without
 * this flag it would simply be absent and indistinguishable from a paging gap.
 * singleEvents expands recurrences (Agon writes none today, but a hand-made
 * recurring event would otherwise return a series it can't align to a session).
 */
export async function listEvents(
  accessToken: string,
  calendarId: string,
  params: { timeMin: string; pageToken?: string; maxResults?: number },
): Promise<ListEventsPage> {
  const qs = new URLSearchParams({
    timeMin: params.timeMin,
    showDeleted: 'true',
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(params.maxResults ?? 250),
  });
  if (params.pageToken) qs.set('pageToken', params.pageToken);
  const res = await gcFetch(
    `/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`,
    accessToken,
  );
  const json = (await res.json()) as {
    items?: unknown[];
    nextPageToken?: string;
  };
  // Validate at the boundary like the rest of the adapter; unknown fields drop.
  const items = z.array(eventResourceSchema).parse(json.items ?? []);
  return { items, nextPageToken: json.nextPageToken };
}

import { z } from 'zod';

// Google Calendar API v3 wire types (only the fields we use) + the OAuth token
// response. Mirrors services/googleHealth/types.ts.

export const googleTokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(), // only on the first consent
  expires_in: z.number().int(),
  token_type: z.string(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});
export type GoogleTokenResponse = z.infer<typeof googleTokenResponseSchema>;

// calendars.insert / calendars.get response (secondary calendar). We only read
// back the id we then persist in agon_calendars.
export const calendarResourceSchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  timeZone: z.string().optional(),
});
export type CalendarResource = z.infer<typeof calendarResourceSchema>;

// events.insert / events.patch response, and the events.list item the reconcile
// pass reads. Writes only need the id (stored in planned_sessions.gcal_event_id
// for idempotent updates); reconcile also needs where the event now SITS and
// whether it still exists — hence `start` and `status` ('cancelled' when the
// athlete deleted it). `start` carries dateTime for a timed event or date for an
// all-day one, since a session dragged to all-day is still a legible statement
// that it moved.
export const eventResourceSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  /** Event title — reconcile reads this for a hand-edited "— X km" override. */
  summary: z.string().optional(),
  /** Event description (HTML) — reconcile reads a bike/lift's hand-edited detail (MZY-262). */
  description: z.string().optional(),
  /**
   * RFC 3339 time of the event's last modification — the HLC input for a
   * calendar hand edit (MZY-208): the edit happened then, not when reconcile
   * notices it.
   */
  updated: z.string().optional(),
  start: z
    .object({
      dateTime: z.string().optional(),
      date: z.string().optional(),
      timeZone: z.string().optional(),
    })
    .optional(),
});
export type EventResource = z.infer<typeof eventResourceSchema>;

/** A timed event boundary: RFC-3339 local datetime + IANA time zone. */
export interface EventDateTime {
  dateTime: string; // e.g. "2026-07-29T07:00:00"
  timeZone: string; // e.g. "Europe/Berlin"
}

/** The subset of a Calendar event resource we write. */
export interface CalendarEventInput {
  summary: string;
  description: string;
  start: EventDateTime;
  end: EventDateTime;
  /** RRULE lines (e.g. "RRULE:FREQ=DAILY;UNTIL=..."). Only used by the meal
   * calendar's standing recurring slots — the training sync writes none. */
  recurrence?: string[];
}

import { query } from '../db';
import { logger } from '../logger';
import {
  getCalendar,
  insertCalendar,
  setCalendarColor,
  GoogleCalendarNotFoundError,
} from './client';
import { DEFAULT_TIME_ZONE } from './eventMap';

// The two dedicated calendars Agon owns. The athlete toggles each on/off
// independently in Google Calendar. 'training' is populated by the sync;
// 'meals' is created now but stays empty until a meal data source exists.
export type CalendarKind = 'training' | 'meals';

// Default colors (Google palette hexes): training = Tomato red, meals = Banana
// yellow. Applied to the user's calendar list on every ensure (idempotent).
export const CALENDAR_SPECS: Record<
  CalendarKind,
  {
    summary: string;
    description: string;
    backgroundColor: string;
    foregroundColor: string;
  }
> = {
  training: {
    summary: 'Agon Training',
    description: 'Planned running + lifting sessions, synced from Agon.',
    backgroundColor: '#D50000', // Tomato (red)
    foregroundColor: '#FFFFFF',
  },
  meals: {
    summary: 'Agon Meals',
    description: 'Nutrition plan, synced from Agon. (Not yet populated.)',
    backgroundColor: '#F6BF26', // Banana (yellow)
    foregroundColor: '#000000', // Google only accepts black/white foreground
  },
};

interface CalendarRow {
  calendar_id: string;
  summary: string;
  time_zone: string | null;
}

async function getRegisteredCalendar(
  kind: CalendarKind,
): Promise<CalendarRow | null> {
  const { rows } = await query<CalendarRow>(
    `SELECT calendar_id, summary, time_zone
       FROM public.agon_calendars WHERE kind = $1`,
    [kind],
  );
  return rows[0] ?? null;
}

async function registerCalendar(
  kind: CalendarKind,
  calendarId: string,
  summary: string,
  timeZone: string,
): Promise<void> {
  await query(
    `INSERT INTO public.agon_calendars (kind, calendar_id, summary, time_zone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (kind) DO UPDATE SET
       calendar_id = EXCLUDED.calendar_id,
       summary     = EXCLUDED.summary,
       time_zone   = EXCLUDED.time_zone`,
    [kind, calendarId, summary, timeZone],
  );
}

/**
 * Return the Google calendar id for a kind, creating the dedicated calendar on
 * first use and remembering it in agon_calendars. Idempotent: a registered
 * calendar is reused; if it was deleted on the Google side (404 on verify), a
 * fresh one is created and re-registered. `accessToken` must be valid.
 */
export async function ensureCalendar(
  accessToken: string,
  kind: CalendarKind,
  timeZone: string = DEFAULT_TIME_ZONE,
): Promise<string> {
  const spec = CALENDAR_SPECS[kind];
  let calendarId: string | null = null;

  const existing = await getRegisteredCalendar(kind);
  if (existing) {
    try {
      await getCalendar(accessToken, existing.calendar_id);
      calendarId = existing.calendar_id; // still there — reuse
    } catch (err) {
      if (!(err instanceof GoogleCalendarNotFoundError)) throw err;
      logger.info('registered calendar missing on Google side — recreating', {
        job: 'google-calendar',
        kind,
      });
    }
  }

  if (!calendarId) {
    const created = await insertCalendar(accessToken, {
      summary: spec.summary,
      description: spec.description,
      timeZone,
    });
    await registerCalendar(kind, created.id, spec.summary, timeZone);
    calendarId = created.id;
    logger.info('created dedicated calendar', {
      job: 'google-calendar',
      kind,
      calendarId,
    });
  }

  // Enforce the calendar's color on every ensure (idempotent). Non-fatal: a color
  // failure shouldn't block the sync of actual sessions.
  try {
    await setCalendarColor(
      accessToken,
      calendarId,
      spec.backgroundColor,
      spec.foregroundColor,
    );
  } catch (err) {
    logger.error(
      'failed to set calendar color',
      { job: 'google-calendar', kind },
      err,
    );
  }

  return calendarId;
}

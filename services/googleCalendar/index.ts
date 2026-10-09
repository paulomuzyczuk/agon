// Public surface of the Google Calendar sync adapter. Mirrors
// services/googleHealth/index.ts.

export {
  authorizeUrl,
  exchangeAuthorizationCode,
  getValidAccessToken,
  getStoredTokens,
  accessTokenIsFresh,
  SCOPE,
  type GoogleCalendarStoredTokens,
} from './oauth';

export {
  insertCalendar,
  getCalendar,
  setCalendarColor,
  insertEvent,
  patchEvent,
  deleteEvent,
  GoogleCalendarRateLimitError,
  GoogleCalendarNotFoundError,
} from './client';

export { ensureCalendar, CALENDAR_SPECS, type CalendarKind } from './calendars';

export {
  mapSessionToEvent,
  estimateRunMinutes,
  DEFAULT_TIME_ZONE,
  type PlannedSessionForEvent,
  type EventMapOptions,
} from './eventMap';

export {
  syncTrainingCalendar,
  describeCalendarSyncSummary,
  type CalendarSyncSummary,
  type CalendarSyncOptions,
  type CalendarSyncDeps,
} from './sync';

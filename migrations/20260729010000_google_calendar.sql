-- Google Calendar sync (CLAUDE.md Premium-Parity #3): push planned_sessions to
-- Google Calendar via OAuth, idempotent through planned_sessions.gcal_event_id.
-- Two dedicated calendars the athlete can toggle on/off independently — one for
-- training sessions (populated), one for meals (created now, dormant until a meal
-- data source exists). Mirrors the Google Health OAuth adapter.

-- Singleton OAuth token row (single-user platform), same shape as
-- google_health_oauth_tokens. Scope: https://www.googleapis.com/auth/calendar
-- (needs create-calendar rights for the dedicated calendars). One consent manages
-- every calendar, so a single token row suffices.
CREATE TABLE public.google_calendar_oauth_tokens (
  id            BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  scope         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_google_calendar_oauth_tokens_touch BEFORE UPDATE ON public.google_calendar_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Registry mapping a logical calendar kind → the Google calendar id the app
-- created for it. Lets the sync be idempotent about calendar creation (create
-- once, reuse forever) and keeps calendar ids out of env/config — they're minted
-- at runtime by calendars.calendars.insert.
CREATE TABLE public.agon_calendars (
  kind        TEXT PRIMARY KEY CHECK (kind IN ('training','meals')),
  calendar_id TEXT NOT NULL UNIQUE,   -- Google calendar id
  summary     TEXT NOT NULL,          -- display name, e.g. "Agon Training"
  time_zone   TEXT,                   -- IANA tz the calendar was created with
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_agon_calendars_touch BEFORE UPDATE ON public.agon_calendars
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

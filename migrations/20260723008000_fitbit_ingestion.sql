-- Fitbit (Google) ingestion. Single-user, so one token row (same singleton
-- pattern as strava_oauth_tokens). daily_activity holds all-day physical-activity
-- totals Strava can't give (steps, floors, active minutes) — Fitbit's native
-- value. Sleep + HRV land in a later migration. Fitbit run HR is stored in the
-- existing run_streams (source 'fitbit'), not here.

CREATE TABLE public.fitbit_oauth_tokens (
  id             BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),  -- singleton
  fitbit_user_id TEXT NOT NULL,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  scope          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_fitbit_oauth_tokens_touch BEFORE UPDATE ON public.fitbit_oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.daily_activity (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date              DATE NOT NULL,
  source            TEXT NOT NULL CHECK (source IN ('fitbit', 'manual')),
  steps             INT CHECK (steps >= 0),
  distance_km       NUMERIC(7,3) CHECK (distance_km >= 0),
  floors            INT CHECK (floors >= 0),
  active_minutes    INT CHECK (active_minutes >= 0),      -- fairly + very active
  sedentary_minutes INT CHECK (sedentary_minutes >= 0),
  calories_out      NUMERIC(7,1) CHECK (calories_out >= 0),
  resting_hr        INT CHECK (resting_hr BETWEEN 0 AND 260),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, source)  -- one row per day per source
);
CREATE INDEX idx_daily_activity_date ON public.daily_activity (date);
CREATE TRIGGER trg_daily_activity_touch BEFORE UPDATE ON public.daily_activity
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.daily_activity TO dbt_writer;

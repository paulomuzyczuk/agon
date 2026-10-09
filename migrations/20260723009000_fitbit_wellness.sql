-- Fitbit wellness: sleep + HRV. (Resting HR already lands in
-- daily_activity.resting_hr via the activity backfill — no new table for it.)
-- Both are recovery signals the analytics layer correlates against training load.

CREATE TABLE public.sleep_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date           DATE NOT NULL,          -- dateOfSleep (the morning you woke)
  source         TEXT NOT NULL CHECK (source IN ('fitbit', 'manual')),
  log_id         BIGINT,                 -- Fitbit sleep log id; idempotency key
  start_at       TIMESTAMPTZ,
  end_at         TIMESTAMPTZ,
  is_main_sleep  BOOLEAN,
  minutes_asleep INT CHECK (minutes_asleep >= 0),
  minutes_awake  INT CHECK (minutes_awake >= 0),
  time_in_bed    INT CHECK (time_in_bed >= 0),
  efficiency     INT CHECK (efficiency BETWEEN 0 AND 100),
  -- sleep-stage minutes (null on older "classic" logs without staging):
  deep_min       INT CHECK (deep_min >= 0),
  light_min      INT CHECK (light_min >= 0),
  rem_min        INT CHECK (rem_min >= 0),
  wake_min       INT CHECK (wake_min >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, log_id)  -- multiple naps/day distinguished by log_id
);
CREATE INDEX idx_sleep_sessions_date ON public.sleep_sessions (date);
CREATE TRIGGER trg_sleep_sessions_touch BEFORE UPDATE ON public.sleep_sessions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TABLE public.hrv_daily (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date        DATE NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('fitbit', 'manual')),
  daily_rmssd NUMERIC(6,2) CHECK (daily_rmssd >= 0),  -- ms, full-sleep RMSSD
  deep_rmssd  NUMERIC(6,2) CHECK (deep_rmssd >= 0),   -- ms, deep-sleep RMSSD
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, source)
);
CREATE INDEX idx_hrv_daily_date ON public.hrv_daily (date);
CREATE TRIGGER trg_hrv_daily_touch BEFORE UPDATE ON public.hrv_daily
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.sleep_sessions TO dbt_writer;
GRANT SELECT ON public.hrv_daily TO dbt_writer;

-- Auto-detected missed stops (MZY-254). The athlete sometimes forgets to stop
-- the recording after getting home; lib/missedStopDetection.ts spots the slow
-- tail after each sync and stores a SUGGESTED late-stop trim here. Nothing is
-- auto-applied (hand edits win): the athlete applies it from the activity
-- page or Telegram (/trim_<n>), which runs the MZY-253 late-stop correction,
-- or dismisses it (/keep_<n>).
--
-- One row per activity, ever: a dismissed suggestion is never re-flagged, and
-- an applied one has already cut the stream. short_id is the small number the
-- Telegram nudge uses in its tap-to-send commands.
--
-- EXPAND phase only (migrations/README.md): a fresh table, nothing destroyed.
CREATE TABLE public.missed_stop_suggestions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id     INT GENERATED ALWAYS AS IDENTITY UNIQUE,
  run_id       UUID REFERENCES public.runs (id) ON DELETE CASCADE,
  ride_id      UUID REFERENCES public.rides (id) ON DELETE CASCADE,
  confidence   TEXT NOT NULL CHECK (confidence IN ('home', 'away')),
  cut_at_s     INT NOT NULL CHECK (cut_at_s >= 0),     -- keep stream samples with time_s ≤ this
  trim_s       INT NOT NULL CHECK (trim_s > 0),        -- max(time_s) − cut_at_s at detection
  distance_km  NUMERIC(7,3) NOT NULL CHECK (distance_km >= 0),
  moving_s     INT NOT NULL CHECK (moving_s >= 0),
  -- open → applied | dismissed; stale = the stream changed since detection
  status       TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'applied', 'dismissed', 'stale')),
  detected_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at  TIMESTAMPTZ,                            -- Telegram nudge sent
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((run_id IS NULL) <> (ride_id IS NULL))
);

CREATE UNIQUE INDEX uq_missed_stop_suggestions_run
  ON public.missed_stop_suggestions (run_id) WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX uq_missed_stop_suggestions_ride
  ON public.missed_stop_suggestions (ride_id) WHERE ride_id IS NOT NULL;

CREATE TRIGGER trg_missed_stop_suggestions_touch BEFORE UPDATE ON public.missed_stop_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.missed_stop_suggestions IS
  'Suggested late-stop trims for runs/rides left recording after the athlete got home (MZY-254). Suggest-only; applied via the MZY-253 correction flow. One row per activity; dismissals persist.';

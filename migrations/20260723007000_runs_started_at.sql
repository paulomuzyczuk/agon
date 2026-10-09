-- Absolute start instant of a run (UTC). Previously only the local `date` was
-- stored. started_at is needed to (a) align a run with a Fitbit intraday-HR
-- window and (b) join weather on start time + GPS (a later milestone). Nullable:
-- manually-entered runs may not have a precise start. Populated by the Strava
-- backfill from the activity's start_date.
ALTER TABLE public.runs ADD COLUMN started_at TIMESTAMPTZ;
CREATE INDEX idx_runs_started_at ON public.runs (started_at);

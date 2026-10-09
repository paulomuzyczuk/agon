-- Capture ledger for /undo. Every bot-driven write (weight, body-fat, sweat, and
-- voice-note fan-outs) appends one row here recording WHICH rows it created, so
-- `/undo` can reverse exactly the last capture — across tables and in the right
-- order — instead of guessing. `targets` is a JSON array of {table, id} pointing
-- at the rows to delete on undo; `undone_at` marks a reversed entry (kept for the
-- audit trail rather than deleted).
--
-- Only rows the bot itself created are ever listed as targets — a voice note that
-- merely ENRICHES an existing Strava run records its fueling items + log, never
-- the run, so /undo can never delete real imported data.
CREATE TABLE public.capture_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,          -- 'weight' | 'bf' | 'sweat' | 'voice-lift' | 'voice-run' | 'voice-body'
  summary     TEXT NOT NULL,          -- human text for the /undo reply
  targets     JSONB NOT NULL,         -- [{ "table": "body_metrics", "id": "..." }, ...]
  source      TEXT NOT NULL DEFAULT 'telegram',
  undone_at   TIMESTAMPTZ,            -- set when reversed; NULL = active/undoable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partial index: /undo only ever looks for the most recent still-active event.
CREATE INDEX idx_capture_events_active
  ON public.capture_events (created_at DESC)
  WHERE undone_at IS NULL;

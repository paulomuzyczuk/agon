-- Realized outcome of a planned session (MZY-417): did it happen, and what did
-- the data say? Written by the weekly calendar reconciliation
-- (scripts/weekly-calendar-reconcile.ts) and rendered into the calendar event.
--
--   planned_sessions.outcome   JSONB {status: 'done'|'not_done', plannedKm,
--                              actualKm?, actualStart?, actualDurationMin?,
--                              source?}. NULL = unknown / not yet reconciled
--                              (a future session, or a lift: no lift data yet).
--   session_adjustments.source gains 'realized' — an overlay written from
--                              recorded data, so it is distinguishable from the
--                              athlete's own manual and calendar edits.
--
-- EXPAND only: a nullable column and a loosened CHECK.

ALTER TABLE public.planned_sessions
  ADD COLUMN IF NOT EXISTS outcome JSONB;

COMMENT ON COLUMN public.planned_sessions.outcome IS
  'Realized outcome from recorded data (done/not_done + actuals); NULL = unknown (MZY-417).';

ALTER TABLE public.session_adjustments
  DROP CONSTRAINT IF EXISTS session_adjustments_source_check;
ALTER TABLE public.session_adjustments
  ADD CONSTRAINT session_adjustments_source_check
  CHECK (source IN ('manual', 'calendar', 'realized'));

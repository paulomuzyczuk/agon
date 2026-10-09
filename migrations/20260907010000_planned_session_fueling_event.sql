-- The calendar sync now creates a companion "🧃 Fueling" event (on the Agon
-- Meals calendar) at the midpoint of any run session at/above
-- LONG_RUN_REMINDER_KM, dosed via lib/fuelingCatalog.ts's estimateFuelingBottles.
-- Mirrors gcal_event_id's role for the main training event: idempotent
-- create-vs-patch, and lets the sync remove a stale fueling event if a program
-- edit drops a session's distance back below the threshold.
ALTER TABLE public.planned_sessions
  ADD COLUMN gcal_fueling_event_id TEXT UNIQUE;

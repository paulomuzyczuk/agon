-- What Agon last pushed to each session's Google Calendar event (MZY-417).
--
-- Reconcile used to decide "the athlete moved/edited this event" by comparing
-- it with the session's CURRENT defaults (default start slot, default detail
-- text). When those defaults changed (2026-10-25: evening runs, 08:30/18:30
-- commutes, 22:30 lifts) every older event looked hand-edited: a dry run found
-- 76 phantom moves, and `--reconcile` would have frozen them as 'strong' start
-- times. An edit is a difference from what Agon itself last wrote, so we keep
-- that.
--
--   gcal_pushed   JSONB {dateTime, summary, description}, copied from the event
--                 resource Google RETURNED for the last insert/patch (not from
--                 what we sent, so Google's own normalisation of the text can't
--                 read as an edit). NULL until the next sync after this
--                 migration; reconcile treats a NULL snapshot as "unknown" and
--                 falls back to the old comparison.
--
-- EXPAND only: nullable, no backfill (the next `pnpm gcal:sync` fills it).

ALTER TABLE public.planned_sessions
  ADD COLUMN IF NOT EXISTS gcal_pushed JSONB;

COMMENT ON COLUMN public.planned_sessions.gcal_pushed IS
  'Event start/summary/description as Google returned them after the last Agon push; a calendar edit is a difference from this (MZY-417).';

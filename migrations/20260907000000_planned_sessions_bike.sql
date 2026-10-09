-- Widen planned_sessions.session_kind to admit 'bike' — the annual plan built
-- 2026-09-07 (desert stage race / marathon / ultra tri-cycle) introduces cycling
-- as a real cross-training session, not just a run/lift/rest day. EXPAND-only:
-- existing rows are untouched, the CHECK constraint simply admits one more value.
ALTER TABLE public.planned_sessions
  DROP CONSTRAINT planned_sessions_session_kind_check;

ALTER TABLE public.planned_sessions
  ADD CONSTRAINT planned_sessions_session_kind_check
  CHECK (session_kind IN ('run', 'lift', 'rest', 'bike'));

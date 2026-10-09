-- Hand-edited session detail survives calendar sync (MZY-262). `detail` holds
-- the athlete's own version of a session's detail lines (a lift's exercise
-- list, a ride's notes and hand-written route) read back from the Google
-- Calendar event by gcal:reconcile. It replaces the program's detail when the
-- event is rendered. One line per row of the event description; lines may carry
-- a sanitized <a href> link (lib/calendarDetail.ts).
--
-- EXPAND phase only (migrations/README.md): one new nullable column. NULL
-- means "no override, render the program's detail".
ALTER TABLE public.session_adjustments
  ADD COLUMN detail TEXT;

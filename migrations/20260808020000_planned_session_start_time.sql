-- Per-session start time for planned_sessions.
--
-- Until now the calendar sync assigned every run a fixed noon slot (and lifts a
-- fixed evening one). That is fine in Berlin, but it broke the moment the plan
-- had a reason to move a session: a heat-wave week abroad wants dawn runs, and
-- an event titled "05:45 start" sitting at 12:00 on the calendar is worse than
-- useless — it says the opposite of the plan.
--
-- A time alone isn't enough, because not every preferred time deserves to
-- override the calendar. Two different things need saying:
--
--   'strong'    — conditions make the default genuinely unsafe or pointless
--                 (40 °C at midday). MOVE the event, and say why in the
--                 description so the change is never mysterious.
--   'suggested' — the default still works; a different time would just be
--                 better. LEAVE the event where it is and put the advice in the
--                 description, so the calendar isn't quietly rearranged over a
--                 preference.
--
-- Hence three columns rather than one: when, how firmly, and why.

ALTER TABLE public.planned_sessions
  ADD COLUMN start_time          TIME,
  ADD COLUMN start_time_priority TEXT
    CHECK (start_time_priority IN ('strong', 'suggested')),
  ADD COLUMN start_time_reason   TEXT;

-- Keep the trio coherent. A time with no priority can't be acted on (move it or
-- not?); a priority or reason with no time describes nothing. And a 'strong'
-- override MUST carry a reason — moving someone's calendar without explaining
-- why is exactly the behaviour this column exists to avoid.
ALTER TABLE public.planned_sessions
  ADD CONSTRAINT planned_sessions_start_time_coherent CHECK (
    (start_time IS NULL
      AND start_time_priority IS NULL
      AND start_time_reason IS NULL)
    OR
    (start_time IS NOT NULL
      AND start_time_priority IS NOT NULL
      AND (start_time_priority <> 'strong' OR start_time_reason IS NOT NULL))
  );

COMMENT ON COLUMN public.planned_sessions.start_time IS
  'Preferred local clock start. NULL = use the sync''s default slot.';
COMMENT ON COLUMN public.planned_sessions.start_time_priority IS
  '''strong'' moves the calendar event; ''suggested'' only advises in the description.';
COMMENT ON COLUMN public.planned_sessions.start_time_reason IS
  'Why this session wants a different time; surfaced in the event description.';

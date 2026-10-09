-- Separate the training PROGRAM from what the athlete actually does.
--
-- planned_sessions has been doing two jobs: it is the program record, seeded from
-- docs/training_program.md and keyed on plan_key, AND the calendar state the
-- Google Calendar sync pushes. So the only way to make the calendar match reality
-- was to overwrite the program in place — re-dating rows until plan_key disagreed
-- with date, rewriting descriptions and distances. By August 2026 ten rows had
-- drifted, including a whole hand-authored heat week.
--
-- That is a live data-loss bug, because upsertPlannedSession does
--   ON CONFLICT (plan_key) DO UPDATE SET date, block, week, session_kind,
--     description, target_distance_km, target_hr_cap, target_session_type
-- so the next `pnpm seed:planned` silently reverts every one of those edits.
--
-- This table is the second layer: at most one adjustment per planned session,
-- holding ONLY the fields that differ from the program. The calendar renders
-- plan + adjustment (see lib/sessionOverlay.ts); the seed writes only the plan.
-- Deviating from the program stops being destructive because the deviation no
-- longer lives in the same row as the program.
--
-- Scope note — which columns belong here. Only the fields the seed's DO UPDATE
-- list actually clobbers need protecting. status, gcal_event_id and the
-- start_time trio are deliberately EXCLUDED from that list already, so they are
-- re-seed-safe where they are and stay on planned_sessions:
--   * status      — set by `pnpm session:status`; never written by the seed.
--   * start_time  — legitimately BOTH plan and reality. The heat week's 05:45
--                   starts are program intent, not a deviation from it, so the
--                   column belongs with the session rather than the override.
-- block/week/session_kind are structural: an adjustment may move a session's
-- date, but block/week are then RECOMPUTED from that date (computeBlockWeek), and
-- a run never becomes a lift. Hence neither is overridable.

CREATE TABLE public.session_adjustments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- One adjustment per session: a second row would make "which override wins?"
  -- a question with no principled answer.
  planned_session_id  UUID NOT NULL UNIQUE
                        REFERENCES public.planned_sessions(id) ON DELETE CASCADE,

  -- Every override is NULLABLE and means "not adjusted" when null, so an
  -- adjustment that only moves a date says nothing about distance.
  date                DATE,
  description         TEXT,
  target_distance_km  NUMERIC(6,2) CHECK (target_distance_km >= 0),
  target_hr_cap       INT CHECK (target_hr_cap BETWEEN 0 AND 260),
  target_session_type TEXT,

  -- Why the session deviates. Surfaced in the calendar event so a moved session
  -- is never mysterious, the same discipline start_time_reason follows.
  note                TEXT,
  -- Who wrote it: 'manual' (CLI/Telegram) or 'calendar' (reconciled from a drag
  -- in Google Calendar). Lets the reconcile pass tell its own writes from the
  -- athlete's explicit ones when resolving a conflict.
  source              TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'calendar')),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- An adjustment with no overrides and no note is a row that says nothing; it
-- would silently survive cleanup passes and confuse "is this session adjusted?".
ALTER TABLE public.session_adjustments
  ADD CONSTRAINT session_adjustments_not_empty CHECK (
    date IS NOT NULL
    OR description IS NOT NULL
    OR target_distance_km IS NOT NULL
    OR target_hr_cap IS NOT NULL
    OR target_session_type IS NOT NULL
    OR note IS NOT NULL
  );

-- The sync selects sessions by RESOLVED date (COALESCE(a.date, p.date)), so the
-- override column is a lookup key, not just payload.
CREATE INDEX idx_session_adjustments_date ON public.session_adjustments (date);

CREATE TRIGGER trg_session_adjustments_touch BEFORE UPDATE
  ON public.session_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.session_adjustments IS
  'Per-session deviations from the seeded program. The calendar renders plan + adjustment; seed:planned never writes here.';

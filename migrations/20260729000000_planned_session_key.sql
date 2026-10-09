-- Seed planned_sessions from the training program (docs/training_program.md,
-- CLAUDE.md Phase 2). The program is the source of truth, so the seed script
-- (scripts/seed-planned-sessions.ts) must be idempotent: re-running after a
-- program edit should UPDATE the descriptive fields of an existing planned row,
-- never insert a duplicate, and never clobber realized state (status,
-- gcal_event_id) that accrued after seeding.
--
-- planned_sessions has no natural key for that upsert — gcal_event_id is NULL
-- until Calendar sync runs, and (date, session_kind) alone can't tell a program
-- edit from a new row. This adds a deterministic program-derived key.
--
-- EXPAND phase only (migrations/README.md): the column lands nullable alongside
-- everything else. The table is unpopulated today, and rows created by other
-- paths (a future ad-hoc planned session) simply carry a NULL key, which is
-- distinct in the unique index below — they never collide with seeded rows.

-- plan_key = "<ISO date>:<session_kind>" (e.g. "2026-03-24:run", "2026-03-24:lift",
-- "2026-03-23:rest"). A program day holds at most one run and at most one lift,
-- so date+kind is unique per seeded session; NULL for non-seeded rows.
ALTER TABLE public.planned_sessions ADD COLUMN plan_key TEXT;

CREATE UNIQUE INDEX idx_planned_sessions_plan_key
  ON public.planned_sessions (plan_key);

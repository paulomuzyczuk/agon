-- Widen gear.category to admit 'bike' (bike ride tracking, 2026-09-10 — the
-- athlete bought a bike). EXPAND-only: existing rows are untouched, the CHECK
-- constraint simply admits one more value. Same shape as
-- 20260907000000_planned_sessions_bike.sql, which already widened
-- planned_sessions.session_kind the same way.
ALTER TABLE public.gear
  DROP CONSTRAINT gear_category_check;

ALTER TABLE public.gear
  ADD CONSTRAINT gear_category_check
  CHECK (category IN ('shoe', 'hrm', 'watch', 'wristband', 'bike', 'other'));

-- Bike maintenance alerts (2026-09-11 — third deferred item from the rides
-- feature, scoped in its own planning pass per CLAUDE.md/backlog.md). A
-- maintenance-task catalog (name, interval_km and/or interval_days) plus a
-- log of completed services per gear item; "km/days since last service" is
-- computed from services/marts/gear.ts's existing gearMileage() total minus
-- the km recorded at the most recent service (see lib/gearMaintenance.ts).
--
-- interval_days stays nullable/supported for a future time-based task (e.g.
-- a general safety check regardless of mileage) but no v1 row uses it —
-- "days since a service that never happened" is left undefined rather than
-- guessed (lib/gearMaintenance.ts computeDueTasks: null, never flagged).
--
-- Due-status is computed only for gear.category = 'bike' rows (see the
-- service/mart layer) — the catalog itself isn't category-scoped, so a shoe
-- accumulating run km must NOT be flagged "chain lube overdue" once it
-- crosses 300 km.
--
-- EXPAND phase only: two fresh tables, nothing destroyed.
CREATE TABLE public.gear_maintenance_tasks (
  task_key      TEXT PRIMARY KEY,          -- e.g. 'chain-lube'
  name          TEXT NOT NULL,             -- e.g. 'Chain lube'
  interval_km   NUMERIC,
  interval_days INT,
  CHECK (interval_km IS NOT NULL OR interval_days IS NOT NULL)
);

CREATE TABLE public.gear_maintenance_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gear_id        TEXT NOT NULL REFERENCES public.gear(gear_id) ON DELETE CASCADE,
  task_key       TEXT NOT NULL REFERENCES public.gear_maintenance_tasks(task_key) ON DELETE CASCADE,
  performed_at   DATE NOT NULL,
  km_at_service  NUMERIC NOT NULL,   -- gear's total km (gearMileage) at the moment of service
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_gear_maintenance_log_gear_task
  ON public.gear_maintenance_log (gear_id, task_key, performed_at DESC);

-- v1 default thresholds (typical road/gravel bike maintenance intervals) —
-- per CLAUDE.md's "don't over-build a multi-bike config system the athlete
-- doesn't need yet", these are the only tunable knobs, and they're plain
-- rows, not code, so a future threshold tweak is an UPDATE, not a deploy.
INSERT INTO public.gear_maintenance_tasks (task_key, name, interval_km) VALUES
  ('chain-lube', 'Chain lube', 300),
  ('chain-drivetrain', 'Chain/drivetrain replacement', 3000),
  ('brake-pads', 'Brake pad check', 1500);

-- Whitelisted raw source for dbt (per 20260723001000_analytics_roles.sql),
-- mirroring every other gear-adjacent table — no mart reads these yet.
GRANT SELECT ON public.gear_maintenance_tasks TO dbt_writer;
GRANT SELECT ON public.gear_maintenance_log TO dbt_writer;

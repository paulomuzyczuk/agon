-- Ride <-> gear join, mirroring public.run_gear
-- (migrations/20260723004000_gear_categories_and_run_gear.sql). A ride can
-- carry several gear items across categories (bike + HRM + watch + ...),
-- same many-to-many shape as run_gear.
CREATE TABLE public.ride_gear (
  ride_id    UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  gear_id    TEXT NOT NULL REFERENCES public.gear(gear_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (ride_id, gear_id)
);
CREATE INDEX idx_ride_gear_gear ON public.ride_gear (gear_id);

GRANT SELECT ON public.ride_gear TO dbt_writer;

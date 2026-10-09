-- Fueling & hydration model for runs AND rides (MZY-64, Premium-Parity #5).
--
-- 1. ride_fueling_items — sibling to run_fueling_items (core_schema), same
--    rides-vs-runs precedent as ride_streams / ride_relative_effort. Resolves
--    against the shared fueling_products catalog (a bottle is a bottle on
--    either activity). timing_km mirrors run_fueling_items.
-- 2. run_fueling_balance / ride_fueling_balance — one derived row per
--    activity, computed by lib/fuelingModel.ts (pure) via
--    scripts/backfill-fueling-balance.ts. Written for every activity ≥ 60 min
--    or with logged intake. Intake columns + flags are NULL when nothing was
--    logged: "didn't drink" and "didn't log" are indistinguishable, so the
--    model refuses to guess.
--
-- EXPAND phase only: fresh tables, nothing destroyed.
CREATE TABLE public.ride_fueling_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ride_id     UUID NOT NULL REFERENCES public.rides(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES public.fueling_products(id) ON DELETE RESTRICT,
  quantity    NUMERIC(6,3) NOT NULL CHECK (quantity > 0),  -- servings, fractional ok
  timing_km   NUMERIC(6,2) CHECK (timing_km >= 0),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ride_fueling_items_ride ON public.ride_fueling_items (ride_id);
CREATE INDEX idx_ride_fueling_items_product ON public.ride_fueling_items (product_id);

CREATE TABLE public.run_fueling_balance (
  run_id                     UUID PRIMARY KEY REFERENCES public.runs(id) ON DELETE CASCADE,
  duration_s                 INT NOT NULL,
  avg_hr                     INT,
  intensity_method           TEXT NOT NULL CHECK (intensity_method IN ('hr', 'assumed')),
  intensity_factor           NUMERIC(5,3) NOT NULL,
  heat_factor                NUMERIC(5,3) NOT NULL,
  baseline_sweat_rate_l_per_h NUMERIC(5,3) NOT NULL,  -- /sweat observation or profile fallback
  sweat_sodium_mg_per_l      NUMERIC(7,1) NOT NULL,
  body_mass_kg               NUMERIC(5,2) NOT NULL,   -- latest weigh-in on/before the date, else profile fallback
  est_sweat_rate_l_per_h     NUMERIC(5,3) NOT NULL,
  est_sweat_loss_l           NUMERIC(6,3) NOT NULL,
  est_sodium_loss_mg         NUMERIC(7,0) NOT NULL,
  carbs_target_min_g_per_h   INT NOT NULL,
  carbs_target_max_g_per_h   INT NOT NULL,
  intake_logged              BOOLEAN NOT NULL,
  fluid_intake_l             NUMERIC(6,3),
  net_fluid_l                NUMERIC(6,3),
  body_mass_loss_pct         NUMERIC(5,2),
  sodium_intake_mg           NUMERIC(7,0),
  net_sodium_mg              NUMERIC(7,0),
  carbs_g                    NUMERIC(6,1),
  carbs_per_h                NUMERIC(6,1),
  dehydrated                 BOOLEAN,
  under_fueled               BOOLEAN,
  computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_run_fueling_balance_touch BEFORE UPDATE ON public.run_fueling_balance
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Identical shape, keyed on ride_id.
CREATE TABLE public.ride_fueling_balance (
  LIKE public.run_fueling_balance INCLUDING DEFAULTS INCLUDING CONSTRAINTS
);
ALTER TABLE public.ride_fueling_balance DROP COLUMN run_id;
ALTER TABLE public.ride_fueling_balance
  ADD COLUMN ride_id UUID PRIMARY KEY REFERENCES public.rides(id) ON DELETE CASCADE;
CREATE TRIGGER trg_ride_fueling_balance_touch BEFORE UPDATE ON public.ride_fueling_balance
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

COMMENT ON TABLE public.run_fueling_balance IS
  'Per-run fueling & hydration estimate (lib/fuelingModel.ts). Surfaced by analytics.fct_run_fueling.';
COMMENT ON TABLE public.ride_fueling_balance IS
  'Per-ride fueling & hydration estimate (lib/fuelingModel.ts), sibling to run_fueling_balance. Surfaced by analytics.fct_ride_fueling.';

-- Whitelisted raw sources for dbt (per 20260723001000_analytics_roles.sql).
GRANT SELECT ON public.ride_fueling_items, public.run_fueling_balance,
  public.ride_fueling_balance TO dbt_writer;

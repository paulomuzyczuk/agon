-- Sweat-rate observations from the Telegram `/sweat` command (CLAUDE.md Telegram
-- Bot Commands + Premium-Parity "Run fueling & hydration model"). Each pre/post
-- weigh-in recalibrates the athlete's baseline sweat rate that the fueling model
-- reads. We store the raw observation (pre/post kg + fluid consumed) plus the
-- derived L/h rate when a run duration was available to divide by — keeping the
-- inputs means the rate can be recomputed if the duration source improves.
CREATE TABLE public.sweat_observations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date                DATE NOT NULL,
  pre_kg              NUMERIC(5,2) NOT NULL CHECK (pre_kg > 0),
  post_kg             NUMERIC(5,2) NOT NULL CHECK (post_kg > 0),
  fluid_l             NUMERIC(5,3) NOT NULL DEFAULT 0 CHECK (fluid_l >= 0),
  -- Effort duration used to turn total sweat loss into a rate; NULL when no run
  -- was available to attribute the weigh-in to, in which case the rate is NULL.
  duration_s          INT CHECK (duration_s > 0),
  run_id              UUID REFERENCES public.runs(id) ON DELETE SET NULL,
  sweat_rate_l_per_h  NUMERIC(5,3) CHECK (sweat_rate_l_per_h >= 0),
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sweat_observations_date ON public.sweat_observations (date);

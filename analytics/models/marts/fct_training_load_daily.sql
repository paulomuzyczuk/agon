-- Daily training load — Agon's reimplementation of Strava's paywalled "Fitness &
-- Freshness" / the TrainingPeaks Performance Management Chart (Banister
-- impulse-response). One row per calendar day over a continuous spine.
--
--   ctl (Fitness) — 42-day EWMA of daily load; the fitness you've banked.
--   atl (Fatigue) — 7-day EWMA; spikes after hard sessions.
--   tsb (Form)    — CTL − ATL; negative = fatigued/building, positive = fresh.
--
-- The sequential EWMA + rest-day-0 spine is computed in the pure, unit-tested
-- lib/trainingLoad.ts and materialized to public.training_load_daily; this mart
-- is the thin presentation layer (adds a couple of derived fields). Daily load is
-- the SUM of per-run Relative Effort — see fct_relative_effort.

with tl as (
    select * from {{ ref('stg_training_load_daily') }}
)

select
    date,
    daily_load,
    ctl,
    atl,
    tsb,
    -- Ramp rate: day-over-day change in Fitness. Positive = building fitness.
    round(ctl - lag(ctl) over (order by date), 1) as ctl_delta,
    -- Human-readable Form zone (TrainingPeaks bands): a coaching gloss on TSB.
    case
        when tsb < -30 then 'high fatigue'
        when tsb < -10 then 'optimal training'
        when tsb <= 5  then 'grey zone'
        when tsb <= 25 then 'fresh'
        else 'transition'
    end as form_zone,
    ctl_days,
    atl_days,
    tsb_mode,
    computed_at
from tl
order by date

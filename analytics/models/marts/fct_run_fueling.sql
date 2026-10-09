-- Per-run fueling & hydration balance (Premium-Parity #5), joined to each
-- run's date/block/week/distance + weather. Sibling: fct_ride_fueling.sql.
-- The model itself (sweat loss from duration × HR intensity × heat, carbs/h
-- guideline, >2% dehydration + under-fueling flags) is computed in
-- lib/fuelingModel.ts — don't recompute it here. Flags are NULL when no
-- intake was logged ("didn't drink" vs "didn't log" is unknowable).

with fb as (
    select * from {{ ref('stg_run_fueling_balance') }}
),

runs as (
    select id, date, block, week, distance_km, temp_c, humidity_pct
    from {{ source('agon_raw', 'runs') }}
)

select
    fb.run_id,
    runs.date,
    runs.block,
    runs.week,
    runs.distance_km,
    fb.duration_s,
    fb.avg_hr,
    runs.temp_c,
    runs.humidity_pct,
    fb.intensity_method,
    fb.est_sweat_rate_l_per_h,
    fb.est_sweat_loss_l,
    fb.est_sodium_loss_mg,
    fb.intake_logged,
    fb.fluid_intake_l,
    fb.net_fluid_l,
    fb.body_mass_loss_pct,
    fb.sodium_intake_mg,
    fb.net_sodium_mg,
    fb.carbs_g,
    fb.carbs_per_h,
    fb.carbs_target_min_g_per_h,
    fb.carbs_target_max_g_per_h,
    fb.dehydrated,
    fb.under_fueled
from fb
inner join runs on runs.id = fb.run_id

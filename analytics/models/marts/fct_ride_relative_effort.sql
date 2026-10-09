-- Per-ride Relative Effort, joined to each ride's date/block/week/distance.
-- Sibling to fct_relative_effort.sql (rides vs. runs). One row per scored
-- ride. The daily SUM of relative_effort, UNIONed with fct_relative_effort's,
-- is the training-load input to fct_training_load_daily (public.
-- training_load_daily is written directly by services/trainingLoad.ts's
-- loadDailyRelativeEffort, which already does that UNION at the SQL level —
-- don't recompute TRIMP here).

with re as (
    select * from {{ ref('stg_ride_relative_effort') }}
),

rides as (
    select id, date, block, week, distance_km, duration_s
    from {{ source('agon_raw', 'rides') }}
)

select
    re.ride_id,
    rides.date,
    rides.block,
    rides.week,
    rides.distance_km,
    rides.duration_s,
    re.relative_effort,
    -- intensity density: RE accrued per hour (higher = harder session).
    round(re.relative_effort / nullif(rides.duration_s, 0) * 3600, 1)
        as relative_effort_per_hour,
    re.method,
    re.stream_source,
    re.hr_rest,
    re.hr_max
from re
inner join rides on rides.id = re.ride_id

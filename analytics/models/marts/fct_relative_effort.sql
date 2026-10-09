-- Per-activity Relative Effort (Agon's Strava-parity training-load score,
-- Premium-Parity #7), joined to each run's date/block/week/distance. One row per
-- scored run. The daily SUM of relative_effort is the training-load input to the
-- future fct_training_load_daily (Banister CTL/ATL/TSB) mart — build that on top
-- of this, don't recompute TRIMP there.

with re as (
    select * from {{ ref('stg_run_relative_effort') }}
),

runs as (
    select id, date, block, week, distance_km, duration_s
    from {{ source('agon_raw', 'runs') }}
)

select
    re.run_id,
    runs.date,
    runs.block,
    runs.week,
    runs.distance_km,
    runs.duration_s,
    re.relative_effort,
    -- intensity density: RE accrued per hour (higher = harder session).
    round(re.relative_effort / nullif(runs.duration_s, 0) * 3600, 1)
        as relative_effort_per_hour,
    re.method,
    re.stream_source,
    re.hr_rest,
    re.hr_max
from re
inner join runs on runs.id = re.run_id

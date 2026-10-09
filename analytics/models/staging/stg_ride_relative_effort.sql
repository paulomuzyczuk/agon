-- Staging view over the per-ride Relative Effort table (Banister TRIMP written by
-- scripts/backfill-relative-effort-rides.ts). Passthrough + a clearer column
-- name. Sibling to stg_run_relative_effort.sql. Grain: one row per ride.

select
    ride_id,
    score as relative_effort,
    method,
    stream_source,
    hr_rest,
    hr_max,
    duration_s,
    avg_hr,
    computed_at
from {{ source('agon_raw', 'ride_relative_effort') }}

-- Staging view over the per-ride mean-maximal power curve (MZY-269): best
-- average watts for each standard duration, DEVICE-measured watts only.
-- Grain: one row per (ride, duration). ride_duration_key is a surrogate for
-- the uniqueness test (no dbt_utils in this project).

select
    ride_id,
    duration_s,
    watts,
    ride_id::text || ':' || duration_s::text as ride_duration_key
from {{ source('agon_raw', 'ride_power_curve') }}

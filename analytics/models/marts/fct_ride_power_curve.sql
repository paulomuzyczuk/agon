-- Per-ride mean-maximal power curve (MZY-269), joined to each ride's date /
-- block / week. One row per (ride, duration). Measured power only: rows exist
-- only for rides with a power-meter stream (ride_streams.watts_source =
-- 'device') — estimated watts never reach it. A season-best curve is a plain
-- `group by duration_s` max(watts) over a date window (done in Lightdash).
-- Mean-max is a true per-duration maximum: it is not forced monotonic.

with curve as (
    select * from {{ ref('stg_ride_power_curve') }}
),

rides as (
    select id, date, block, week
    from {{ source('agon_raw', 'rides') }}
)

select
    curve.ride_duration_key,
    curve.ride_id,
    rides.date,
    rides.block,
    rides.week,
    curve.duration_s,
    curve.watts
from curve
join rides on rides.id = curve.ride_id

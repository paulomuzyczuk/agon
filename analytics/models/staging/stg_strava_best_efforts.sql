-- Staging view over the raw Strava best-efforts reference pull. Casts nothing
-- exotic; adds the derived pace (seconds per km) so the mart and any consumer
-- share one definition. Grain unchanged: one row per (activity, named distance).

with src as (
    select * from {{ source('agon_raw', 'strava_best_efforts') }}
)

select
    strava_activity_id,
    effort_name,
    distance_m,
    elapsed_time_s,
    moving_time_s,
    pr_rank,
    started_at,
    activity_started_at,
    -- elapsed pace at this effort's distance (s/km); distance_m is CHECK > 0.
    round(elapsed_time_s / (distance_m / 1000.0), 1) as pace_s_per_km,
    captured_at
from src

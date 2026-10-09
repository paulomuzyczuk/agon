-- Staging view over the source-agnostic best-efforts table
-- (public.run_best_efforts), derived from Agon's own runs/run_streams by
-- lib/bestEfforts.ts (`pnpm be:backfill`) — supersedes stg_strava_best_efforts
-- as the input to fct_run_best_efforts. Adds the derived pace (seconds per
-- km), same convention as the Strava-sourced staging model. Grain unchanged:
-- one row per (run_id, effort_name).

with src as (
    select * from {{ source('agon_raw', 'run_best_efforts') }}
)

select
    run_id,
    effort_name,
    distance_m,
    elapsed_time_s,
    method,
    stream_source,
    -- elapsed pace at this effort's distance (s/km); distance_m is CHECK > 0.
    round(elapsed_time_s / (distance_m / 1000.0), 1) as pace_s_per_km,
    achieved_at,
    computed_at
from src

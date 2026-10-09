-- Per-ride power summary with provenance (MZY-267). One row per ride that
-- has ANY power. power_source says what the watts are: 'device' (measured by
-- a power meter), 'estimated' (the source's model — Strava's estimate is
-- what every ride gets without a meter) or 'manual' (hand-logged via
-- `pnpm ride:add`). Filter on power_source = 'device' before treating watts
-- as data; estimated watts are kept for display, never computed on.
--
-- Agon-computed NP / IF / TSS (MZY-269) are joined from
-- stg_ride_power_metrics. They derive from a power meter's MEASURED stream
-- only, so they are null on every estimated/manual ride; IF/TSS are also
-- null without an FTP (ftp_w = the FTP used). The power curve is
-- fct_ride_power_curve. Training load stays Relative Effort
-- (fct_ride_relative_effort) — TSS never adds to it, so no ride is counted
-- twice.

with rides as (
    select
        id, date, block, week, distance_km, duration_s,
        avg_power_w, max_power_w, weighted_avg_power_w, kilojoules,
        power_source, source
    from {{ source('agon_raw', 'rides') }}
    where power_source is not null
),

metrics as (
    select * from {{ ref('stg_ride_power_metrics') }}
)

select
    rides.id as ride_id,
    date,
    block,
    week,
    distance_km,
    duration_s,
    power_source,
    power_source = 'device' as is_measured,
    avg_power_w,
    max_power_w,
    weighted_avg_power_w,
    kilojoules,
    -- mechanical work rate; equals avg power for a ride with no coasting gaps
    round(kilojoules * 1000 / nullif(duration_s, 0), 0) as work_rate_w,
    -- Agon's own, measured-stream-only metrics (null unless is_measured)
    metrics.np_w,
    metrics.intensity_factor,
    metrics.tss,
    metrics.ftp_w,
    source
from rides
left join metrics on metrics.ride_id = rides.id

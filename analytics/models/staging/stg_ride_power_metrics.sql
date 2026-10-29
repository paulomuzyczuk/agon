-- Staging view over Agon's per-ride power metrics (MZY-269): NP / IF / TSS
-- computed by lib/power.ts from DEVICE-measured watts only (scripts/
-- backfill-ride-power-metrics.ts, services/activityDerived.ts). Passthrough +
-- clearer names. Grain: one row per ride with a power-meter stream.

select
    ride_id,
    stream_source,
    ftp_w,
    np_w,
    intensity_factor,
    tss,
    duration_s as active_duration_s,
    avg_power_w as measured_avg_power_w,
    max_power_w as measured_max_power_w,
    kilojoules as measured_kilojoules,
    zone_seconds,
    computed_at
from {{ source('agon_raw', 'ride_power_metrics') }}

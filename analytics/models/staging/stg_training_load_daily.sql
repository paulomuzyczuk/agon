-- Staging view over the daily training-load table (Banister CTL/ATL/TSB written
-- by scripts/backfill-training-load.ts). Passthrough. Grain: one row per calendar
-- day (continuous spine; rest days carry daily_load 0).

select
    date,
    daily_load,
    ctl,
    atl,
    tsb,
    ctl_days,
    atl_days,
    tsb_mode,
    computed_at
from {{ source('agon_raw', 'training_load_daily') }}

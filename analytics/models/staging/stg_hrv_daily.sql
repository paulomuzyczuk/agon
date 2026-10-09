-- Staging view over daily HRV (RMSSD) from Google Health (Fitbit Air, written by
-- `pnpm gh:wellness`). daily_rmssd is the whole-night average; deep_rmssd is the
-- deep-sleep window. Grouped by date as a single-source dedupe guard (see
-- stg_daily_activity). HRV arrives sparsely — most days carry no row, which the
-- wellness mart's date spine renders as a gap. Grain: one row per day.

select
    date,
    max(daily_rmssd) as daily_rmssd,
    max(deep_rmssd)  as deep_rmssd
from {{ source('agon_raw', 'hrv_daily') }}
group by date

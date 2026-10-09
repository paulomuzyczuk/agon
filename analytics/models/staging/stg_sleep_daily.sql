-- Staging view over sleep, aggregated from per-session sleep_sessions to one row
-- per calendar day. A day can hold several sessions (naps), and is_main_sleep is
-- null for Google Health, so day-level sleep is the SUM of that day's sessions.
-- Day efficiency is DERIVED from the summed asleep/in-bed minutes rather than
-- averaging per-session percentages (there is no reliable per-day summary field).
-- Grain: one row per day.

select
    date,
    sum(minutes_asleep) as minutes_asleep,
    sum(minutes_awake)  as minutes_awake,
    sum(time_in_bed)    as time_in_bed,
    case
        when sum(time_in_bed) > 0
        then round(100.0 * sum(minutes_asleep) / sum(time_in_bed))
    end                 as efficiency,
    sum(deep_min)       as deep_min,
    sum(light_min)      as light_min,
    sum(rem_min)        as rem_min,
    sum(wake_min)       as wake_min,
    count(*)            as sessions
from {{ source('agon_raw', 'sleep_sessions') }}
group by date

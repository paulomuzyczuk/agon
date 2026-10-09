-- Daily wellness / recovery — one row per calendar day over a continuous spine,
-- LEFT JOINing the three recovery signals so they can be read against training
-- load (fct_training_load_daily) on a shared date axis:
--
--   resting_hr     — Google Health / Fitbit Air daily resting heart rate (bpm).
--   daily_rmssd    — HRV (whole-night RMSSD, ms); deep_rmssd = deep-sleep window.
--   minutes_asleep — summed over the day's sleep sessions; sleep_efficiency %.
--   deep/light/rem/wake_min — sleep stage split (summed).
--   active_minutes — all-day active minutes.
--
-- The three sources are sparse and don't all cover the same days, so this is a
-- LEFT JOIN onto a generated date spine: a day with only a resting-HR reading and
-- no sleep/HRV still appears, with the missing metrics NULL. Consumers render
-- those NULLs as gaps, never as zero. Grain: one row per calendar day.

with activity as (
    select * from {{ ref('stg_daily_activity') }}
),

hrv as (
    select * from {{ ref('stg_hrv_daily') }}
),

sleep as (
    select * from {{ ref('stg_sleep_daily') }}
),

-- Every day any signal was recorded, to bound the spine.
all_days as (
    select date from activity
    union
    select date from hrv
    union
    select date from sleep
),

bounds as (
    select min(date) as min_date, max(date) as max_date from all_days
),

-- Continuous day-by-day spine from first to last observed day. Guarded so an
-- empty source set yields no rows (rather than erroring on a null range).
spine as (
    select generate_series(min_date, max_date, interval '1 day')::date as date
    from bounds
    where min_date is not null
)

select
    spine.date,
    activity.resting_hr,
    activity.active_minutes,
    hrv.daily_rmssd,
    hrv.deep_rmssd,
    sleep.minutes_asleep,
    sleep.efficiency as sleep_efficiency,
    sleep.deep_min,
    sleep.light_min,
    sleep.rem_min,
    sleep.wake_min
from spine
left join activity on activity.date = spine.date
left join hrv on hrv.date = spine.date
left join sleep on sleep.date = spine.date
order by spine.date

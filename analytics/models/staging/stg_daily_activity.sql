-- Staging view over daily activity + resting HR (Google Health / Fitbit Air,
-- written by `pnpm gh:wellness`). Only resting_hr and active_minutes are
-- populated for the google_health source; steps/distance/floors/calories are
-- null (the multi-source dailyRollup is unresolved — see CLAUDE.md) and are
-- deliberately NOT surfaced here. Grouped by date as a single-source dedupe
-- guard so the wellness mart keeps exactly one row per calendar day even if a
-- second activity source is ever added. Grain: one row per day.

select
    date,
    max(resting_hr)     as resting_hr,
    max(active_minutes) as active_minutes
from {{ source('agon_raw', 'daily_activity') }}
group by date

-- Staging view over body_metrics (weight/BF% weigh-ins, logged via Telegram
-- `/weight` and `/bf`). A single weigh-in day can carry two source rows (weight
-- and BF% logged separately — e.g. two 2026-07-22 rows in the real data), so this
-- is grouped by date the same way stg_daily_activity dedupes daily_activity: one
-- row per calendar day, MAX per metric (there is never more than one non-null
-- value per metric per day in practice). Grain: one row per day with a weigh-in.

select
    date,
    max(weight_kg)     as weight_kg,
    max(body_fat_pct)  as body_fat_pct
from {{ source('agon_raw', 'body_metrics') }}
group by date

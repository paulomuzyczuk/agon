-- Body-composition trend — weight (kg) and body-fat % over time, one row per
-- calendar day over a continuous spine (same shape as fct_wellness_daily): the
-- athlete logs sparse, irregular weigh-ins (roughly monthly, occasionally split
-- across two same-day entries for weight vs BF%), so a daily spine keeps the x
-- axis time-proportional — a weigh-in after a 4-week gap doesn't render as if it
-- were the very next reading. Missing days are NULL; render as gaps, never zero.

with body as (
    select * from {{ ref('stg_body_metrics') }}
),

bounds as (
    select min(date) as min_date, max(date) as max_date from body
),

-- Guarded so an empty source yields no rows rather than erroring on a null range.
spine as (
    select generate_series(min_date, max_date, interval '1 day')::date as date
    from bounds
    where min_date is not null
)

select
    spine.date,
    body.weight_kg,
    body.body_fat_pct
from spine
left join body on body.date = spine.date
order by spine.date

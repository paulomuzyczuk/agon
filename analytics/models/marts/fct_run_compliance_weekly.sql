-- Weekly run compliance: actual km logged vs. the training program's planned
-- weekly km, plus easy-run HR-zone adherence vs. target_hr_cap (CLAUDE.md
-- Block 1: "Zero HR spikes above 154 bpm on easy days" — the HR cap is a
-- per-planned-session field, set only on days the program actually caps).
-- One row per (block, week). Simple version, per CLAUDE.md: avg_hr vs. the
-- cap, not a stream-level time-in-zone read (a follow-up).
--
-- HR compliance matches each ACTUAL run to a PLANNED run session by date (the
-- program plans at most one run per day), so it only scores days the plan
-- actually capped — tempo/interval days with no cap don't count against
-- compliance, matching the program's own intent.

with actual_weekly as (
    select
        block,
        week,
        sum(distance_km) as actual_km
    from {{ source('agon_raw', 'runs') }}
    where block is not null and week is not null
    group by block, week
),

planned_weekly as (
    select
        block,
        week,
        sum(target_distance_km) as target_km
    from {{ source('agon_raw', 'planned_sessions') }}
    where session_kind = 'run' and target_distance_km is not null
    group by block, week
),

hr_compliance as (
    select
        r.block,
        r.week,
        count(*) as easy_runs_capped,
        count(*) filter (
            where r.avg_hr is not null and r.avg_hr <= ps.target_hr_cap
        ) as easy_runs_compliant
    from {{ source('agon_raw', 'runs') }} r
    inner join {{ source('agon_raw', 'planned_sessions') }} ps
        on ps.date = r.date
        and ps.session_kind = 'run'
        and ps.target_hr_cap is not null
    where r.block is not null and r.week is not null
    group by r.block, r.week
),

weeks as (
    select block, week from actual_weekly
    union
    select block, week from planned_weekly
    union
    select block, week from hr_compliance
)

select
    weeks.block,
    weeks.week,
    'B' || weeks.block || 'W' || lpad(weeks.week::text, 2, '0') as block_week,
    actual_weekly.actual_km,
    planned_weekly.target_km,
    round(
        actual_weekly.actual_km / nullif(planned_weekly.target_km, 0) * 100, 1
    ) as km_compliance_pct,
    hr_compliance.easy_runs_capped,
    hr_compliance.easy_runs_compliant,
    round(
        hr_compliance.easy_runs_compliant::numeric
            / nullif(hr_compliance.easy_runs_capped, 0) * 100,
        1
    ) as hr_compliance_pct
from weeks
left join actual_weekly
    on actual_weekly.block = weeks.block and actual_weekly.week = weeks.week
left join planned_weekly
    on planned_weekly.block = weeks.block and planned_weekly.week = weeks.week
left join hr_compliance
    on hr_compliance.block = weeks.block and hr_compliance.week = weeks.week
order by weeks.block, weeks.week

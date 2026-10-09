-- Staging view over the per-run Relative Effort table (Banister TRIMP written by
-- scripts/backfill-relative-effort.ts). Passthrough + a clearer column name.
-- Grain: one row per run.

select
    run_id,
    score as relative_effort,
    method,
    stream_source,
    hr_rest,
    hr_max,
    duration_s,
    avg_hr,
    computed_at
from {{ source('agon_raw', 'run_relative_effort') }}

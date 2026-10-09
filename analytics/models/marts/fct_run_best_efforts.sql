-- The athlete's best effort (fastest split) at each named distance, across
-- all runs — their per-distance PRs. Repointed 2026-09-05 from the frozen,
-- one-time Strava-premium pull (stg_strava_best_efforts) to the
-- source-agnostic pipeline derived from Agon's own runs/run_streams
-- (lib/bestEfforts.ts, `pnpm be:backfill`), so any live source keeps feeding
-- new PRs. The live race-prediction pipeline
-- (services/racePrediction.ts::loadBestEffortPairs) reads
-- public.run_best_efforts directly rather than this mart, because fitting the
-- Riegel exponent needs EVERY 'full_run' pair (one per run, deduped to the
-- fastest pace within each 1 km bin), not just the single fastest ever — see
-- that module's doc comment.
--
-- Grain: one row per named distance (a fixed bucket like '5K', or the special
-- 'full_run' name). 'full_run' here collapses to the single fastest whole-run
-- effort ever recorded regardless of distance — informational only, not a
-- stable "PR category" the way a fixed bucket distance is.
--
-- DISTINCT ON keeps the fastest elapsed split per distance (ties -> earliest
-- by achieved_at, deterministic).

select distinct on (effort_name)
    effort_name,
    distance_m,
    elapsed_time_s,
    pace_s_per_km,
    method,
    stream_source,
    run_id as pr_run_id,
    achieved_at
from {{ ref('stg_run_best_efforts') }}
order by effort_name, elapsed_time_s asc, achieved_at asc

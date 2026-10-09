-- Predicted race times (Premium-Parity #2) — 1k/5k/10k/half/marathon (+ a 70k
-- extrapolation). Strava has no race-prediction feature at all, so this is
-- net-new (docs/strava-benchmark.md). Headline = a Riegel power law with the
-- exponent RECALIBRATED from the athlete's own best efforts; Daniels VDOT and the
-- generic-k=1.06 Riegel are reported alongside as cross-checks.
--
-- The heavy lifting (log-log fit, VDOT inversion) is in the pure, unit-tested
-- lib/racePrediction.ts, materialized to public.race_predictions; this mart is
-- the thin presentation layer, adding derived paces for readability.
--
-- Grain: one row per target distance.

with rp as (
    select * from {{ ref('stg_race_predictions') }}
)

select
    label,
    distance_m,
    predicted_s,
    -- Derived paces (s per km) for the headline + band, easier to read than raw s.
    round(predicted_s / (distance_m / 1000.0)) as predicted_pace_s_per_km,
    low_s,
    high_s,
    band_pct,
    riegel_self_s,
    riegel_generic_s,
    vdot_s,
    -- Spread between the two models: a transparency signal (agreement = confidence).
    case when vdot_s is not null
        then abs(riegel_self_s - vdot_s)
    end as riegel_vdot_gap_s,
    extrapolated,
    fit_k,
    fit_r2,
    fit_fallback,
    n_pairs,
    ref_vdot,
    ref_distance_m,
    ref_time_s,
    computed_at
from rp
order by distance_m

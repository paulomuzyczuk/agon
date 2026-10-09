-- Staging view over the race-predictions table (Riegel + VDOT, written by
-- scripts/backfill-race-predictions.ts). Passthrough. Grain: one row per target
-- distance.

select
    label,
    distance_m,
    predicted_s,
    riegel_self_s,
    riegel_generic_s,
    vdot_s,
    low_s,
    high_s,
    band_pct,
    extrapolated,
    fit_k,
    fit_a,
    fit_r2,
    fit_fallback,
    n_pairs,
    ref_vdot,
    ref_distance_m,
    ref_time_s,
    computed_at
from {{ source('agon_raw', 'race_predictions') }}

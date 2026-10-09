-- Staging view over the per-ride fueling & hydration balance written by
-- scripts/backfill-fueling-balance.ts (lib/fuelingModel.ts, MZY-64).
-- Passthrough. Grain: one row per modelled ride (≥ 60 min or intake logged).

select
    ride_id,
    duration_s,
    avg_hr,
    intensity_method,
    intensity_factor,
    heat_factor,
    baseline_sweat_rate_l_per_h,
    sweat_sodium_mg_per_l,
    body_mass_kg,
    est_sweat_rate_l_per_h,
    est_sweat_loss_l,
    est_sodium_loss_mg,
    carbs_target_min_g_per_h,
    carbs_target_max_g_per_h,
    intake_logged,
    fluid_intake_l,
    net_fluid_l,
    body_mass_loss_pct,
    sodium_intake_mg,
    net_sodium_mg,
    carbs_g,
    carbs_per_h,
    dehydrated,
    under_fueled,
    computed_at
from {{ source('agon_raw', 'ride_fueling_balance') }}

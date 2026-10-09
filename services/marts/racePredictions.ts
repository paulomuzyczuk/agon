import { query } from '@/services/db';
import type {
  RacePrediction,
  RacePredictionFit,
  VerifiedBestEffort,
} from '@/lib/marts';

// Read side of the race-predictions mart for the PWA. The dbt mart
// analytics.fct_race_predictions is the single source of truth (self-recalibrated
// Riegel + Daniels VDOT cross-check); this module only shapes rows for the API
// boundary. No business logic here — the math lives in lib/racePrediction.ts and
// the mart. Numerics are cast to float in SQL (pg returns `numeric` as string).

interface Row {
  label: string;
  distance_m: number;
  predicted_s: number;
  predicted_pace_s_per_km: number;
  low_s: number;
  high_s: number;
  band_pct: number;
  riegel_self_s: number;
  riegel_generic_s: number;
  vdot_s: number | null;
  riegel_vdot_gap_s: number | null;
  extrapolated: boolean;
  fit_k: number;
  fit_r2: number;
  fit_fallback: boolean;
  n_pairs: number;
  ref_vdot: number | null;
}

interface BestEffortRow {
  effort_name: string;
  elapsed_time_s: number;
  pace_s_per_km: number;
  method: 'stream' | 'whole_run';
  stream_source: string | null;
  pr_run_id: string | null;
  achieved_at: string;
}

/**
 * Maps a fct_race_predictions.label to the fct_run_best_efforts.effort_name
 * it should be verified against. Deliberately explicit, not a string-equality
 * assumption — the two marts spell distances differently (`Half-Marathon` vs
 * `Half_Marathon`), and 70K has no bucket at all in STANDARD_EFFORT_DISTANCES
 * (lib/bestEfforts.ts) — it's a pure extrapolation with no verified PR possible.
 */
const EFFORT_NAME_BY_PREDICTION_LABEL: Record<string, string> = {
  '1K': '1K',
  '5K': '5K',
  '10K': '10K',
  'Half-Marathon': 'Half_Marathon',
  Marathon: 'Marathon',
};

async function loadVerifiedBestEfforts(): Promise<
  Map<string, VerifiedBestEffort>
> {
  const effortNames = Object.values(EFFORT_NAME_BY_PREDICTION_LABEL);
  const { rows } = await query<BestEffortRow>(
    `
    select
      effort_name,
      elapsed_time_s::float8   as elapsed_time_s,
      pace_s_per_km::float8    as pace_s_per_km,
      method,
      stream_source,
      pr_run_id::text          as pr_run_id,
      achieved_at::date::text  as achieved_at
    from analytics.fct_run_best_efforts
    where effort_name = any($1::text[])
    `,
    [effortNames],
  );

  const byEffortName = new Map<string, VerifiedBestEffort>(
    rows.map((r) => [
      r.effort_name,
      {
        elapsedTimeS: r.elapsed_time_s,
        paceSPerKm: r.pace_s_per_km,
        method: r.method,
        streamSource: r.stream_source,
        prRunId: r.pr_run_id,
        achievedAt: r.achieved_at,
      },
    ]),
  );

  const byLabel = new Map<string, VerifiedBestEffort>();
  for (const [label, effortName] of Object.entries(
    EFFORT_NAME_BY_PREDICTION_LABEL,
  )) {
    const effort = byEffortName.get(effortName);
    if (effort) byLabel.set(label, effort);
  }
  return byLabel;
}

/**
 * All predicted race times, ascending by distance, plus the shared fit
 * provenance (identical across every row — the recalibrated exponent is a single
 * athlete-level fit, so it's lifted out of the per-row list).
 */
export async function getRacePredictions(): Promise<{
  predictions: RacePrediction[];
  fit: RacePredictionFit | null;
}> {
  const [{ rows }, verifiedByLabel] = await Promise.all([
    query<Row>(
      `
    select
      label,
      distance_m,
      predicted_s,
      predicted_pace_s_per_km::float8   as predicted_pace_s_per_km,
      low_s,
      high_s,
      band_pct::float8                  as band_pct,
      riegel_self_s,
      riegel_generic_s,
      vdot_s,
      riegel_vdot_gap_s,
      extrapolated,
      fit_k::float8                     as fit_k,
      fit_r2::float8                    as fit_r2,
      fit_fallback,
      n_pairs,
      ref_vdot::float8                  as ref_vdot
    from analytics.fct_race_predictions
    order by distance_m asc
    `,
    ),
    loadVerifiedBestEfforts(),
  ]);

  const predictions: RacePrediction[] = rows.map((r) => ({
    label: r.label,
    distanceM: r.distance_m,
    predictedS: r.predicted_s,
    predictedPaceSPerKm: r.predicted_pace_s_per_km,
    lowS: r.low_s,
    highS: r.high_s,
    bandPct: r.band_pct,
    riegelSelfS: r.riegel_self_s,
    riegelGenericS: r.riegel_generic_s,
    vdotS: r.vdot_s,
    riegelVdotGapS: r.riegel_vdot_gap_s,
    extrapolated: r.extrapolated,
    verified: verifiedByLabel.get(r.label) ?? null,
  }));

  const first = rows[0];
  const fit: RacePredictionFit | null = first
    ? {
        fitK: first.fit_k,
        fitR2: first.fit_r2,
        fitFallback: first.fit_fallback,
        nPairs: first.n_pairs,
        refVdot: first.ref_vdot,
      }
    : null;

  return { predictions, fit };
}

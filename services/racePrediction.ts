import { query } from './db';
import { FULL_RUN_EFFORT_NAME } from '../lib/bestEfforts';
import {
  fitRiegel,
  riegelFromFit,
  type EffortPair,
  type RacePrediction,
  type RiegelFit,
  type VdotReference,
} from '../lib/racePrediction';

// DB access for the race-prediction backfill. The models are pure
// (lib/racePrediction.ts); this module reads the best-effort PAIRS and upserts
// the predictions. Orchestration lives in scripts/backfill-race-predictions.ts.

// Best-effort pairs come from public.run_best_efforts (source-agnostic,
// derived from runs/run_streams by lib/bestEfforts.ts + `pnpm be:backfill`) —
// NOT public.strava_best_efforts, a frozen one-time Strava-premium pull that
// stopped receiving new runs 2026-08-01. Two shapes are combined:
//
//   * Named buckets ('5K', '10K', ...) — a genuine PR search: the fastest
//     elapsed time at each distance across the whole history, same pattern as
//     the old Strava-sourced query.
//   * 'full_run' — one row per run at that run's OWN distance, so it can't be
//     deduped the same way (a run's distance isn't a fixed bucket). Most
//     full_run rows are ordinary training paces, not maximal efforts, so
//     feeding every one into the Riegel fit would bias the exponent toward
//     average pace. Two filters keep only genuine signal:
//       1. Group by distance rounded to the nearest FULL_RUN_BIN_KM and keep
//          only the fastest PACE within each bin — every distinct long-run
//          distance stays its own anchor point (e.g. 21.1/23/24 km don't
//          collide), while slower repeats near a faster run's distance are
//          dropped.
//       2. "Beat the curve": fit Riegel on the bucket pairs ALONE first, then
//          keep a bin-deduped full_run pair only if it's FASTER than that
//          bucket-only fit already predicts at its distance. A full_run pair
//          slower than the curve is an ordinary training run — no new
//          evidence about the athlete's capability, and including it anyway
//          measurably swamps the genuine short-distance PRs (empirically: 22
//          full_run points against 8 bucket points dragged the self-
//          calibrated fit's own 1K prediction slower than the athlete's
//          actual 1K best effort). A full_run pair faster than the curve IS
//          new evidence (exactly the "long run better than the fatigue curve
//          implies" case this pipeline was built to stop losing) and is kept.
const FULL_RUN_BIN_KM = 1;

async function loadBucketPairs(): Promise<EffortPair[]> {
  const { rows } = await query<{ distance_m: string; elapsed_time_s: string }>(
    `SELECT DISTINCT ON (effort_name)
            distance_m, elapsed_time_s
       FROM public.run_best_efforts
      WHERE effort_name <> $1
      ORDER BY effort_name, elapsed_time_s ASC, achieved_at ASC`,
    [FULL_RUN_EFFORT_NAME],
  );
  return rows.map((r) => ({
    distanceM: Number(r.distance_m),
    timeS: Number(r.elapsed_time_s),
  }));
}

async function loadFullRunPairs(): Promise<EffortPair[]> {
  const { rows } = await query<{ distance_m: string; elapsed_time_s: string }>(
    `SELECT DISTINCT ON (bin) distance_m, elapsed_time_s
       FROM (
         SELECT distance_m, elapsed_time_s,
                ROUND(distance_m / ($2 * 1000.0)) AS bin,
                elapsed_time_s / distance_m AS pace
           FROM public.run_best_efforts
          WHERE effort_name = $1
       ) binned
      ORDER BY bin, pace ASC`,
    [FULL_RUN_EFFORT_NAME, FULL_RUN_BIN_KM],
  );
  return rows.map((r) => ({
    distanceM: Number(r.distance_m),
    timeS: Number(r.elapsed_time_s),
  }));
}

/**
 * The athlete's best-effort pairs feeding the Riegel/VDOT fit: named-bucket
 * PRs plus the full-run pairs that beat the bucket-only fatigue curve (see
 * module doc above). Source table is public.run_best_efforts, populated by
 * `pnpm be:backfill`.
 */
export async function loadBestEffortPairs(): Promise<EffortPair[]> {
  const [buckets, fullRuns] = await Promise.all([
    loadBucketPairs(),
    loadFullRunPairs(),
  ]);

  const bucketFit = fitRiegel(buckets);
  if (!bucketFit) return [...buckets, ...fullRuns]; // too few bucket pairs to curate against

  const beatsCurve = fullRuns.filter(
    (p) => p.timeS < riegelFromFit(bucketFit, p.distanceM),
  );
  return [...buckets, ...beatsCurve];
}

/** Idempotent upsert of one prediction row (label PK — recompute overwrites). */
export async function upsertRacePrediction(
  p: RacePrediction,
  fit: RiegelFit,
  vdotRef: VdotReference | null,
): Promise<void> {
  await query(
    `INSERT INTO public.race_predictions
       (label, distance_m, predicted_s, riegel_self_s, riegel_generic_s, vdot_s,
        low_s, high_s, band_pct, extrapolated,
        fit_k, fit_a, fit_r2, fit_fallback, n_pairs, ref_vdot, ref_distance_m,
        ref_time_s, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
     ON CONFLICT (label) DO UPDATE SET
       distance_m       = EXCLUDED.distance_m,
       predicted_s      = EXCLUDED.predicted_s,
       riegel_self_s    = EXCLUDED.riegel_self_s,
       riegel_generic_s = EXCLUDED.riegel_generic_s,
       vdot_s           = EXCLUDED.vdot_s,
       low_s            = EXCLUDED.low_s,
       high_s           = EXCLUDED.high_s,
       band_pct         = EXCLUDED.band_pct,
       extrapolated     = EXCLUDED.extrapolated,
       fit_k            = EXCLUDED.fit_k,
       fit_a            = EXCLUDED.fit_a,
       fit_r2           = EXCLUDED.fit_r2,
       fit_fallback     = EXCLUDED.fit_fallback,
       n_pairs          = EXCLUDED.n_pairs,
       ref_vdot         = EXCLUDED.ref_vdot,
       ref_distance_m   = EXCLUDED.ref_distance_m,
       ref_time_s       = EXCLUDED.ref_time_s,
       computed_at      = now()`,
    [
      p.label,
      p.distanceM,
      p.predictedS,
      p.riegelSelfS,
      p.riegelGenericS,
      p.vdotS,
      p.lowS,
      p.highS,
      p.bandPct,
      p.extrapolated,
      fit.k,
      fit.a,
      fit.r2,
      fit.fallback,
      fit.n,
      vdotRef?.vdot ?? null,
      vdotRef ? Math.round(vdotRef.from.distanceM) : null,
      vdotRef ? Math.round(vdotRef.from.timeS) : null,
    ],
  );
}

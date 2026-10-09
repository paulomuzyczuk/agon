// Pure best-effort extraction (distance, time) pairs, DB-free + unit-tested.
// Feeds lib/racePrediction.ts's EffortPair input — replaces the one-time
// Strava-premium best_efforts pull (public.strava_best_efforts, frozen since
// 2026-08-05) with a source-agnostic pipeline derived from Agon's own
// runs/run_streams, so any live source (Google Health, manual Telegram
// entries, file imports) keeps the race-prediction model fresh.
//
// Two tiers, both producing an EffortPair:
//
//   Stream tier    A run with a distance-bearing run_streams row (source
//                  'strava' or 'google_health'; 'fitbit' streams are HR-only,
//                  no distance). findBestEffort() runs a sliding-window search
//                  for the fastest elapsed time to cover a target distance
//                  ANYWHERE in the run — a genuine best effort, same idea as
//                  Strava's own best_efforts extraction. fullStreamEffort()
//                  gives the run's own full distance/time from the stream's
//                  first/last sample.
//
//   Whole-run tier A run with no distance-bearing stream (e.g. a manually
//                  logged long run with no GPS track). wholeRunEffort() falls
//                  back to the run's own distance_km/duration_s as a single,
//                  coarser "the pace they ran" data point — not a true
//                  best-of-segment, but real signal, especially at long
//                  distances where a true sub-segment barely differs from the
//                  whole-run average anyway.
//
// Credit: same sliding-window PR extraction idea Strava/GoldenCheetah use —
// formula/approach only, no code copied (CREDITS.md discipline).

import type { EffortPair } from './racePrediction';

export interface StandardEffortDistance {
  name: string;
  meters: number;
}

/** Standard named split distances, ascending — mirrors Strava's own labels. */
export const STANDARD_EFFORT_DISTANCES: StandardEffortDistance[] = [
  { name: '1K', meters: 1000 },
  { name: '1_mile', meters: 1609.34 },
  { name: '5K', meters: 5000 },
  { name: '10K', meters: 10000 },
  { name: '15K', meters: 15000 },
  { name: '10_mile', meters: 16093.4 },
  { name: '20K', meters: 20000 },
  { name: 'Half_Marathon', meters: 21097.5 },
  { name: 'Marathon', meters: 42195 },
];

/** The special per-run effort name: the run's own full distance/time. */
export const FULL_RUN_EFFORT_NAME = 'full_run';

export interface StreamBestEffort {
  /** Elapsed time (s) to cover the target distance — interpolated for precision. */
  elapsedS: number;
  /** Index of the window's start sample (left edge, sample-aligned). */
  startIdx: number;
  /** Index of the window's end sample (right edge; the crossing may fall between endIdx-1 and endIdx). */
  endIdx: number;
}

/**
 * Cumulative distance arrays occasionally regress slightly (GPS jitter) —
 * clamp any decrease to the running maximum so the sliding window below can
 * assume a non-decreasing axis without discarding the sample entirely.
 */
function monotonicNonDecreasing(distanceM: number[]): number[] {
  const out = new Array<number>(distanceM.length);
  let max = -Infinity;
  for (let i = 0; i < distanceM.length; i++) {
    max = Math.max(max, distanceM[i]!);
    out[i] = max;
  }
  return out;
}

/**
 * Fastest elapsed time to cover targetDistanceM anywhere within an
 * index-aligned (timeS, distanceM) stream — a two-pointer sliding window,
 * O(n). The right edge is linearly interpolated between its two bracketing
 * samples for sub-sample precision; the left edge stays sample-aligned
 * (unnecessary to interpolate both ends given ~1-3s sampling). Returns null
 * when the stream is too short/malformed, or never covers targetDistanceM.
 */
export function findBestEffort(
  timeS: number[],
  distanceM: number[],
  targetDistanceM: number,
): StreamBestEffort | null {
  const n = timeS.length;
  if (n < 2 || distanceM.length !== n || targetDistanceM <= 0) return null;
  const dist = monotonicNonDecreasing(distanceM);

  let best: StreamBestEffort | null = null;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n - 1 && dist[j]! - dist[i]! < targetDistanceM) j++;
    const covered = dist[j]! - dist[i]!;
    if (covered < targetDistanceM) break; // remaining range only shrinks from here

    let elapsedS: number;
    const coveredPrev = j > i ? dist[j - 1]! - dist[i]! : covered;
    if (j > i && coveredPrev < targetDistanceM) {
      // Interpolate the exact crossing between samples j-1 and j.
      const d0 = dist[j - 1]!;
      const d1 = dist[j]!;
      const t0 = timeS[j - 1]!;
      const t1 = timeS[j]!;
      const frac = d1 > d0 ? (targetDistanceM - (d0 - dist[i]!)) / (d1 - d0) : 0;
      const targetTime = t0 + frac * (t1 - t0);
      elapsedS = targetTime - timeS[i]!;
    } else {
      elapsedS = timeS[j]! - timeS[i]!;
    }

    if (elapsedS > 0 && (best === null || elapsedS < best.elapsedS)) {
      best = { elapsedS, startIdx: i, endIdx: j };
    }
  }
  return best;
}

/**
 * How far (as a fraction of the bucket) a whole stream may fall SHORT of a
 * named bucket and still count toward it — 0.2%, i.e. 4990 m for a 5K
 * (athlete-set, MZY-217). Stream distance is GPS-measured and
 * buildNetAdjustedStream deliberately drops the drift recorded during a
 * confirmed stop, so a run that was a 5K can come out a few metres under
 * 5000 m; without this it would silently drop out of the 5K bucket
 * entirely (live: the 2026-07-14 5K PR at 4998 m).
 */
export const BUCKET_SHORTFALL_TOLERANCE = 0.002;

/**
 * findBestEffort for a named bucket, tolerating a whole stream that falls
 * just short of it (see BUCKET_SHORTFALL_TOLERANCE). When no window reaches
 * the target, the only candidate is the full stream; its time is scaled up
 * to the full target distance at its own average pace — never credited the
 * missing metres for free. Returns null when the stream is further short
 * than the tolerance (or malformed).
 */
export function findBucketEffort(
  timeS: number[],
  distanceM: number[],
  targetDistanceM: number,
): StreamBestEffort | null {
  const exact = findBestEffort(timeS, distanceM, targetDistanceM);
  if (exact) return exact;
  const n = timeS.length;
  if (n < 2 || distanceM.length !== n || targetDistanceM <= 0) return null;
  const dist = monotonicNonDecreasing(distanceM);
  const covered = dist[n - 1]! - dist[0]!;
  const elapsed = timeS[n - 1]! - timeS[0]!;
  if (covered <= 0 || elapsed <= 0) return null;
  if (covered < targetDistanceM * (1 - BUCKET_SHORTFALL_TOLERANCE)) return null;
  return { elapsedS: (elapsed * targetDistanceM) / covered, startIdx: 0, endIdx: n - 1 };
}

/**
 * The run's own full distance/time from a stream's first/last sample — more
 * accurate than runs.duration_s (reflects actual recorded time, not
 * device-reported duration). Null for a too-short or non-positive stream.
 */
export function fullStreamEffort(
  timeS: number[],
  distanceM: number[],
): EffortPair | null {
  const n = timeS.length;
  if (n < 2 || distanceM.length !== n) return null;
  const elapsed = timeS[n - 1]! - timeS[0]!;
  const total = distanceM[n - 1]! - distanceM[0]!;
  if (elapsed <= 0 || total <= 0) return null;
  return { distanceM: total, timeS: elapsed };
}

/**
 * Whole-run tier: a run with no distance-bearing stream contributes its own
 * distance/duration as a single, coarser data point (the pace they ran, not a
 * true best-of-segment). Null for non-positive inputs.
 */
export function wholeRunEffort(
  distanceKm: number,
  durationS: number,
): EffortPair | null {
  if (distanceKm <= 0 || durationS <= 0) return null;
  return { distanceM: distanceKm * 1000, timeS: durationS };
}

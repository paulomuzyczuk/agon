// Elevation gain from a GPS altitude series (MZY-295). Pure — the live
// flush (services/liveRecording*.ts) and the backfill
// (scripts/backfill-elevation-gain.ts) both call it on the stored
// run_streams/ride_streams `distance_m` + `altitude_m`; unit-tested in
// __tests__/lib/elevationGain.test.ts.
//
// A phone has no barometer reading here, so its altitude wobbles by metres
// every second and a raw sum of the positive deltas inflates gain badly.
// Ported from gpx.studio's `_elevationComputation` (gpx/src/gpx.ts, plus
// `ramerDouglasPeucker` from gpx/src/simplify.ts and the distance-window
// smoothing helpers), MIT — see CREDITS.md and the notice below:
//  1. Ramer-Douglas-Peucker on the (distance, elevation) curve, ε = 20 m,
//     keeps the real turning points of the profile.
//  2. Within each RDP segment, a 100 m distance-window moving average —
//     distance-based, so it holds up when pace or fix rate changes; the
//     segment's two endpoints keep their raw altitude.
//  3. Sum the rises of that smoothed series — through a 0.5 m hysteresis
//     band (Agon's addition, below).
// Changes from the original: plain arrays instead of GPXStatistics/
// TrackPoint, distance in metres, points without altitude or distance are
// dropped first (gpx.studio treats a missing `ele` as 0), and the band.
//
// Why 0.5 m (MZY-295, measured on 86 Strava runs/rides from the dev DB with
// an upstream gain): the moving average still wiggles by centimetres, and
// summing every wiggle reads +21 % median (+103 % with 1 m of added noise —
// a flat 5 km track then "climbs" 15 m). A ratchet band — the idea of
// GoldenCheetah's GC_ELEVATION_HYSTERESIS (GPL-2.0, idea only) and
// OpenTracks' altitude staircase (Apache-2.0) — removes that. Their 3 m is
// meant for RAW altitude; on this already-smoothed series it halves real
// gain (−51 % median). 0.5 m had the most activities within 15 % (53/86,
// median |error| 1.7 m) and stayed unbiased with added noise (+3 %).
//
// ---------------------------------------------------------------------------
// MIT License
//
// Copyright (c) 2026 gpx.studio
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ---------------------------------------------------------------------------

/** gpx.studio's RDP tolerance on the (distance m, elevation m) curve. */
export const RDP_EPSILON_M = 20;
/** gpx.studio's distance-window moving average (0.1 km). */
export const SMOOTHING_WINDOW_M = 100;
/** Fewer usable points than this → no gain (null), not a misleading 0. */
export const MIN_POINTS = 2;
/** A rise or fall smaller than this on the smoothed series isn't counted. */
export const HYSTERESIS_M = 0.5;

export interface ElevationGainOptions {
  /** Defaults to {@link HYSTERESIS_M}; 0 sums every rise (plain gpx.studio). */
  hysteresisM?: number;
}

/** Perpendicular distance from c to the line through a and b (gpx.studio). */
function lineDistance(
  x: readonly number[],
  y: readonly number[],
  a: number,
  b: number,
  c: number,
): number {
  const [x1, y1, x2, y2, x3, y3] = [x[a]!, y[a]!, x[b]!, y[b]!, x[c]!, y[c]!];
  const dist = Math.hypot(y2 - y1, x2 - x1);
  if (dist === 0) return Math.hypot(x3 - x1, y3 - y1);
  return Math.abs((y2 - y1) * x3 - (x2 - x1) * y3 + x2 * y1 - y2 * x1) / dist;
}

/** Indices RDP keeps, in order, always including the first and last. */
function ramerDouglasPeucker(
  x: readonly number[],
  y: readonly number[],
  epsilon: number,
): number[] {
  const kept = [0];
  // Iterative stand-in for gpx.studio's recursion (same visiting order), so
  // a long recording can't overflow the stack.
  const stack: Array<[number, number]> = [[0, x.length - 1]];
  const inner: number[] = [];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let largest = 0;
    let index = 0;
    for (let i = start + 1; i < end; i++) {
      const d = lineDistance(x, y, start, end, i);
      if (d > largest) {
        largest = d;
        index = i;
      }
    }
    if (largest > epsilon && index !== 0) {
      stack.push([index, end], [start, index]);
      inner.push(index);
    }
  }
  kept.push(...inner.sort((a, b) => a - b), x.length - 1);
  return kept;
}

/**
 * Smoothed altitude at every index of [left, right], each the mean over the
 * points within `window` metres of it (gpx.studio `windowSmoothing`).
 */
function smoothSegment(
  x: readonly number[],
  y: readonly number[],
  left: number,
  right: number,
  window: number,
): number[] {
  const out: number[] = [];
  const end = right + 1;
  let start = left;
  for (let i = left; i < end; i++) {
    while (start + 1 < i && x[i]! - x[start]! > window) start++;
    let stop = Math.min(i + 2, end);
    while (stop < end && x[stop]! - x[i]! <= window) stop++;
    let sum = 0;
    for (let k = start; k < stop; k++) sum += y[k]!;
    out.push(sum / (stop - start));
  }
  // The segment keeps its raw endpoints, so segments join exactly.
  out[0] = y[left]!;
  out[out.length - 1] = y[right]!;
  return out;
}

/** The smoothed profile, one value per usable point (exported for tests). */
export function smoothedElevationProfile(
  distanceM: ReadonlyArray<number | null>,
  altitudeM: ReadonlyArray<number | null>,
): number[] {
  const x: number[] = [];
  const y: number[] = [];
  const n = Math.min(distanceM.length, altitudeM.length);
  for (let i = 0; i < n; i++) {
    const d = distanceM[i];
    const a = altitudeM[i];
    if (d == null || a == null || !Number.isFinite(+d) || !Number.isFinite(+a))
      continue;
    x.push(Number(d));
    y.push(Number(a));
  }
  if (x.length < MIN_POINTS) return [];
  const kept = ramerDouglasPeucker(x, y, RDP_EPSILON_M);
  const profile = [y[0]!];
  for (let s = 0; s < kept.length - 1; s++) {
    // Drop each segment's first value: it is the previous one's last.
    profile.push(
      ...smoothSegment(x, y, kept[s]!, kept[s + 1]!, SMOOTHING_WINDOW_M).slice(
        1,
      ),
    );
  }
  return profile;
}

/**
 * Total ascent (m, 1 dp) along a track, or null with fewer than
 * {@link MIN_POINTS} points carrying both a distance and an altitude.
 */
export function elevationGainM(
  distanceM: ReadonlyArray<number | null>,
  altitudeM: ReadonlyArray<number | null>,
  options: ElevationGainOptions = {},
): number | null {
  const profile = smoothedElevationProfile(distanceM, altitudeM);
  if (profile.length < MIN_POINTS) return null;
  const band = options.hysteresisM ?? HYSTERESIS_M;
  let gain = 0;
  let ref = profile[0]!;
  for (const v of profile.slice(1)) {
    if (band <= 0) {
      if (v > ref) gain += v - ref;
      ref = v;
    } else if (v - ref >= band) {
      gain += v - ref;
      ref = v;
    } else if (ref - v >= band) {
      ref = v;
    }
  }
  return Math.round(gain * 10) / 10;
}

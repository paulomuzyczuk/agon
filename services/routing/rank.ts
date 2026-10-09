import { gainPerKm } from './elevation';
import { routeBearing } from './bearing';
import { windExposurePenalty, type RouteForecast } from './weather';
import type { Coord, RouteCandidate } from './types';

// Pure ranking (decision: "3 routes, distance-accuracy then flattest"). Order
// candidates by how close their actual length is to the requested target, then
// by climb, and keep the top N. Deterministic and side-effect-free → unit-tested
// directly.
//
// Distance accuracy is compared in BANDS rather than exactly. An earlier version
// sorted on the raw metre error and only consulted elevation on an exact tie —
// which, with float metre distances, never happens, so the "then flattest" rule
// was dead and a route 3 m closer to target always beat one 200 m flatter. Two
// routes within a few percent of the target are equally good as "today's 10 km";
// what actually distinguishes them is the climb.
//
// A wind tiebreak (weather.ts) is folded in the same way, one step below
// elevation: same-band, same-ascent candidates are then ordered by headwind
// exposure. Optional — omit `weather` to rank exactly as before (every existing
// caller keeps working unchanged). No network call happens here; the caller
// fetches the forecast and passes it in.
//
// Deliberately untouched for cycling (Premium-Parity #6 bike extension): the
// ranking here operates on distance and climb, neither of which is a walking-
// specific assumption, so "closest to target, then flattest, then least
// headwind" is exactly what an easy Zone-2 bike loop wants too — no separate
// tuning needed. Same reasoning applies to diversity.ts (bearing is pure
// geometry) and calibrate.ts (its correction ratio is length-only, not pace).

/**
 * Distance errors within this fraction of the target count as equally accurate,
 * so elevation decides between them. 5% ≈ 500 m on a 10 km run.
 */
export const DISTANCE_BAND = 0.05;

export interface RankedCandidate extends RouteCandidate {
  /** Absolute distance error vs. the target, in metres. */
  distanceErrorM: number;
  /**
   * Ascent per kilometre — the comparable hilliness figure. Total ascent alone
   * can't be compared across routes of different lengths (+300 m over 20 km is
   * gentle; over 5 km it is not). Null when the engine returned no elevation.
   */
  elevationGainPerKmM: number | null;
  /** Compass bearing of the loop's apex from the start (set by diverse selection). */
  bearingDeg?: number;
  /** Compass label for `bearingDeg` (N/NE/…), set by diverse selection. */
  direction?: string;
  /**
   * Headwind exposure penalty (km/h-equivalent; see weather.ts) — absent/null
   * when ranking was called without a `weather` forecast, 0 when a forecast was
   * given but this candidate faces no meaningful headwind.
   */
  windPenalty?: number | null;
}

/**
 * Rank candidates for a target distance and return the best `keep` (default 3).
 * Primary key: distance-accuracy BAND. Within a band: least TOTAL ascent (nulls
 * sort last — "unknown, least preferred"), then least headwind exposure (only
 * when `weather` is given), then the exact distance error, then seed so
 * ordering is stable.
 *
 * Within-band comparison deliberately uses total ascent, not ascent-per-km:
 * candidates in the same band are near-identical in length, and dividing by
 * distance there would just reward the longer route for spreading the same climb
 * further. Per-km is the figure we SHOW (it is what compares a 5 km option to a
 * 20 km one); total ascent is what decides between two versions of today's run.
 */
export function rankCandidates(
  candidates: RouteCandidate[],
  targetKm: number,
  keep = 3,
  weather?: { start: Coord; forecast: RouteForecast | null },
): RankedCandidate[] {
  const targetM = targetKm * 1000;
  const bandM = Math.max(1, targetM * DISTANCE_BAND);
  const ranked: RankedCandidate[] = candidates.map((c) => ({
    ...c,
    distanceErrorM: Math.abs(c.distanceM - targetM),
    elevationGainPerKmM: gainPerKm(c.elevationGainM, c.distanceM),
    windPenalty: weather
      ? windExposurePenalty(
          routeBearing(weather.start, c.coordinates),
          weather.forecast,
        )
      : null,
  }));
  const band = (c: RankedCandidate): number =>
    Math.floor(c.distanceErrorM / bandM);
  ranked.sort((a, b) => {
    if (band(a) !== band(b)) return band(a) - band(b);
    const ga = a.elevationGainM ?? Number.POSITIVE_INFINITY;
    const gb = b.elevationGainM ?? Number.POSITIVE_INFINITY;
    if (ga !== gb) return ga - gb;
    const wa = a.windPenalty ?? 0;
    const wb = b.windPenalty ?? 0;
    if (wa !== wb) return wa - wb;
    if (a.distanceErrorM !== b.distanceErrorM) {
      return a.distanceErrorM - b.distanceErrorM;
    }
    return a.seed - b.seed;
  });
  return ranked.slice(0, Math.max(0, keep));
}

import type { RankedCandidate } from './rank';
import type { CrossingCounts } from './crossings';

// Picks the ONE route a time trial runs on (athlete's request, 2026-10-15):
// fewest traffic lights first, since every red light is an unmeasured stop;
// then fewest plain crossings; then a loop that covers the whole distance
// (a short loop leaves the last metres off-route); then distance accuracy;
// then the flattest. Pure.
//
// Only loops within DISTANCE_TOLERANCE of the target compete. ORS round_trip
// occasionally returns a degenerate loop (a 1.9 km one for a 10 km trial,
// 2026-10-16), and a loop a fifth the length trivially has fewer lights.

export interface ScoredCandidate {
  candidate: RankedCandidate;
  /** Null when the crossings couldn't be counted. */
  crossings: CrossingCounts | null;
}

// Uncounted routes rank after every counted one: an unknown is not a zero.
const UNKNOWN = Number.POSITIVE_INFINITY;
// Engines land loops within a few percent; under 1% short still counts as full.
const FULL_DISTANCE_FRACTION = 0.99;
// Wider than an engine's usual few-percent miss, so a fair loop is never lost.
const DISTANCE_TOLERANCE = 0.1;

/** True when a loop of `distanceM` is close enough to the trial distance. */
export function withinTimeTrialDistance(
  distanceM: number,
  targetKm: number,
): boolean {
  const targetM = targetKm * 1000;
  return Math.abs(distanceM - targetM) <= targetM * DISTANCE_TOLERANCE;
}

function sortKey(s: ScoredCandidate, targetM: number): number[] {
  const c = s.candidate;
  return [
    s.crossings?.trafficSignals ?? UNKNOWN,
    s.crossings?.plainCrossings ?? UNKNOWN,
    c.distanceM >= targetM * FULL_DISTANCE_FRACTION ? 0 : 1,
    Math.abs(c.distanceM - targetM),
    c.elevationGainM ?? UNKNOWN,
  ];
}

/** Negative when key a sorts before key b (element by element). */
function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

/**
 * The best time-trial route, or null for an empty pool. Ties keep pool order.
 * When no loop is within tolerance, the one closest in distance wins.
 */
export function pickTimeTrialRoute<T extends ScoredCandidate>(
  pool: T[],
  targetKm: number,
): T | null {
  const targetM = targetKm * 1000;
  const fair = pool.filter((s) =>
    withinTimeTrialDistance(s.candidate.distanceM, targetKm),
  );
  if (fair.length === 0) {
    return pool.reduce<T | null>(
      (best, s) =>
        !best ||
        Math.abs(s.candidate.distanceM - targetM) <
          Math.abs(best.candidate.distanceM - targetM)
          ? s
          : best,
      null,
    );
  }
  let best: { s: T; key: number[] } | null = null;
  for (const s of fair) {
    const key = sortKey(s, targetM);
    if (!best || compareKeys(key, best.key) < 0) best = { s, key };
  }
  return best?.s ?? null;
}

/**
 * The label suffix for a time-trial route: its red-light exposure, and how far
 * to carry on past the loop when it comes up short of the trial distance.
 */
export function timeTrialLabelSuffix(
  s: ScoredCandidate,
  targetKm: number,
): string {
  const parts: string[] = [];
  parts.push(
    s.crossings
      ? `${s.crossings.trafficSignals} traffic light${s.crossings.trafficSignals === 1 ? '' : 's'}, ` +
          `${s.crossings.plainCrossings} other crossing${s.crossings.plainCrossings === 1 ? '' : 's'}`
      : 'crossings not counted',
  );
  const shortM = Math.round(targetKm * 1000 - s.candidate.distanceM);
  if (shortM >= 10) parts.push(`run ${shortM} m past the finish`);
  return parts.join(' · ');
}

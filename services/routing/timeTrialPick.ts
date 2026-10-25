import type { RankedCandidate } from './rank';
import type { CrossingCounts } from './crossings';

// Picks the ONE route a time trial runs on (athlete's request, 2026-10-15):
// fewest traffic lights first, since every red light is an unmeasured stop;
// then fewest plain crossings; then a loop that covers the whole distance
// (a short loop leaves the last metres off-route); then distance accuracy;
// then the flattest. Pure.

export interface ScoredCandidate {
  candidate: RankedCandidate;
  /** Null when the crossings couldn't be counted. */
  crossings: CrossingCounts | null;
}

// Uncounted routes rank after every counted one: an unknown is not a zero.
const UNKNOWN = Number.POSITIVE_INFINITY;
// Engines land loops within a few percent; under 1% short still counts as full.
const FULL_DISTANCE_FRACTION = 0.99;

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

/** The best time-trial route, or null for an empty pool. Ties keep pool order. */
export function pickTimeTrialRoute<T extends ScoredCandidate>(
  pool: T[],
  targetKm: number,
): T | null {
  const targetM = targetKm * 1000;
  let best: { s: T; key: number[] } | null = null;
  for (const s of pool) {
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

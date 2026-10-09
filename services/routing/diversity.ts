import type { Coord } from './types';
import type { RankedCandidate } from './rank';
import { compassDirection, routeBearing, angularDistance } from './bearing';

// Directional diversity for route suggestions. Ranking by distance-accuracy alone
// tends to return near-identical loops (all heading down the same street); the
// athlete asked for a few SIGNIFICANTLY different routes. We characterise each
// loop by the compass bearing of its farthest point (apex) from the start, then
// greedily pick the set whose directions are spread as widely as possible while
// still favouring distance accuracy. Pure + unit-tested.
//
// The bearing math itself lives in ./bearing (shared with rank.ts's
// weather-weighted tiebreak — importing it back from here would cycle, since
// this file imports RankedCandidate from rank.ts). Re-exported below so existing
// imports of compassDirection/routeBearing from this module keep working.

export { compassDirection, routeBearing };

export interface DiverseCandidate extends RankedCandidate {
  bearingDeg: number;
  direction: string;
}

/**
 * Pick `keep` candidates that head in the most different directions. Input should
 * be pre-ranked by accuracy (best first); we seed the selection with the most
 * accurate loop, then greedily add whichever remaining loop is most
 * angularly-separated from those already chosen (ties broken by accuracy). Every
 * returned candidate carries its bearing + compass direction.
 */
export function selectDiverse(
  ranked: RankedCandidate[],
  start: Coord,
  keep: number,
): DiverseCandidate[] {
  const annotated: DiverseCandidate[] = ranked.map((c) => {
    const bearingDeg = routeBearing(start, c.coordinates);
    return { ...c, bearingDeg, direction: compassDirection(bearingDeg) };
  });
  if (annotated.length <= keep) return annotated;

  const selected: DiverseCandidate[] = [annotated[0]!]; // most accurate first
  const rest = annotated.slice(1);
  while (selected.length < keep && rest.length > 0) {
    let bestIdx = 0;
    let bestSep = -1;
    for (let i = 0; i < rest.length; i++) {
      const sep = Math.min(
        ...selected.map((s) =>
          angularDistance(s.bearingDeg, rest[i]!.bearingDeg),
        ),
      );
      if (
        sep > bestSep ||
        (sep === bestSep &&
          rest[i]!.distanceErrorM < rest[bestIdx]!.distanceErrorM)
      ) {
        bestSep = sep;
        bestIdx = i;
      }
    }
    selected.push(rest.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

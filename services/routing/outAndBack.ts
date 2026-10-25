import type { Coord, RouteCandidate } from './types';

// An out-and-back from a one-way route: run the route to a turnaround, then
// back down the same street. The turnaround sits half the requested total from
// the start, so a trial lands on its distance instead of on however far the
// turnaround place happens to be (a place 2.6 km out would make the 5 km
// time trial 5.2 km). Pure.

const EARTH_R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Approximate metres between two [lng, lat] geometry points. */
function stepM(a: number[], b: number[]): number {
  const dLat = toRad(b[1]! - a[1]!);
  const dLng = toRad(b[0]! - a[0]!);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1]!)) * Math.cos(toRad(b[1]!)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * `out` cut at `totalM / 2` along its geometry (kept whole when it is already
 * shorter), then mirrored back to the start. Distances follow the engine's own
 * figure for `out`, so the result is consistent with every other candidate.
 * Elevation is null: the climb of a trimmed route isn't in the engine's total.
 */
export function outAndBackFrom(
  out: RouteCandidate,
  totalM: number,
): RouteCandidate & { turnaround: Coord } {
  const pts = out.coordinates;
  if (pts.length < 2) {
    throw new Error(
      `outAndBackFrom: expected an outbound route with at least 2 points, got ${pts.length}`,
    );
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + stepM(pts[i - 1]!, pts[i]!));
  }
  // Scale the geometry's length to the engine's reported distance.
  const scale =
    cum[cum.length - 1]! > 0 ? out.distanceM / cum[cum.length - 1]! : 1;
  const legM = Math.min(totalM / 2, out.distanceM);

  const kept: number[][] = [pts[0]!];
  let lastM = 0;
  for (let i = 1; i < pts.length; i++) {
    const atM = cum[i]! * scale;
    if (atM >= legM) {
      const span = atM - lastM;
      const t = span > 0 ? (legM - lastM) / span : 0;
      const a = pts[i - 1]!;
      const b = pts[i]!;
      kept.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t]);
      break;
    }
    kept.push(pts[i]!);
    lastM = atM;
  }
  const tip = kept[kept.length - 1]!;
  const back = kept.slice(0, -1).reverse();
  return {
    ...out,
    distanceM: legM * 2,
    elevationGainM: null,
    coordinates: [...kept, ...back],
    turnaround: { lng: tip[0]!, lat: tip[1]! },
  };
}

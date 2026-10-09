import {
  isCyclingProfile,
  type Coord,
  type RouteCandidate,
  type RouteProfile,
} from './types';

// Pure Google Maps "Directions" deep-link builder — the secondary,
// phone-glance artifact (CLAUDE.md #6: "a Maps deep-link URL is a bonus"). The
// Maps URL API caps waypoints (origin + destination + intermediates) at ~10, so
// a 1000-point loop is downsampled to a handful of evenly-spaced via points that
// preserve the loop's rough shape. This is NOT a saved route (no clean API for
// that) — it's a walking-directions link the athlete can open at a glance.
//
// Maps re-routes its OWN shortest path between consecutive vias, so where the
// vias sit decides how faithfully the link reproduces the loop. Evenly-spaced
// vias (the original approach) let Maps shortcut every detour between them:
// measured on 27 stored Berlin loops (MZY-31) the re-routed link ran 9.3% short
// on average, 14.5% at worst (an 18.4 km loop opened as 16.0 km in Google Maps).
// Vias are therefore picked by SHAPE — greedily, the geometry point furthest
// from the chord of the stretch it sits in — which pins exactly the detours a
// shortest-path router would cut: mean error 1.35%, worst 5.3% on the same set
// (18.4 km loop → 18.9 km in Google Maps).
//
// For a CONSTRAINED route ("pass through X"), any via selection can drop the
// through-point entirely — the GPX (exact) honours it, but the tappable link
// wouldn't show it. `mustInclude` guarantees each given point survives by pinning
// the geometry index nearest to it before the remaining slots are filled.

const MAPS_BASE = 'https://www.google.com/maps/dir/?api=1';
// Origin + destination are the same point (loop); leave headroom under the ~10
// cap for intermediate via points.
const MAX_WAYPOINTS = 8;
/** Google Maps `travelmode` for a routing profile (default 'foot-walking' → walking). */
function travelMode(profile?: RouteProfile): 'walking' | 'bicycling' {
  return isCyclingProfile(profile) ? 'bicycling' : 'walking';
}

// The geometry's first/last stretch is often just the route walking away down
// the SAME street the start is on — real points, but colinear with start and
// adding no shape information, so picking one there (as plain even-sampling
// always does at index 0) wastes a via slot on a "stop" that reads as a
// duplicate of home/finish in the Maps UI (e.g. the next building over).
// Points within this distance of start or end are excluded from the FILL pool
// (never from an intentional mustInclude match) so a slot goes to a point that
// actually differentiates the route. ~200m clears a typical Berlin block.
const MIN_EDGE_GAP_M = 200;

/** Approximate metres between two [lng,lat] geometry/coord points (equirectangular). */
function metersBetween(a: number[], b: number[]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const midLat = toRad((a[1]! + b[1]!) / 2);
  const dx = toRad(b[0]! - a[0]!) * Math.cos(midLat);
  const dy = toRad(b[1]! - a[1]!);
  return Math.sqrt(dx * dx + dy * dy) * R;
}

/** Approximate metres from point p to the segment a→b (equirectangular around p). */
function metersToSegment(p: number[], a: number[], b: number[]): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const k = Math.cos(toRad(p[1]!));
  const ax = (a[0]! - p[0]!) * k;
  const ay = a[1]! - p[1]!;
  const dx = (b[0]! - p[0]!) * k - ax;
  const dy = b[1]! - p[1]! - ay;
  const lenSq = dx * dx + dy * dy;
  // Degenerate segment (a loop's start === end): distance to the point itself.
  const t =
    lenSq > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lenSq)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy) * toRad(1) * 6371000;
}

// Below this, the best remaining candidate adds no shape (a straight stretch):
// fall back to splitting the widest remaining gap so the vias still spread out.
const MIN_SHAPE_DEVIATION_M = 1;

/** Pick n evenly-spaced elements from arr (always includes first + last). */
export function downsample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr.slice();
  if (n <= 1) return arr.length ? [arr[0]!] : [];
  const out: T[] = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]!);
  return out;
}

/** "lat,lng" with fixed precision (Maps accepts ~5–6 decimals). */
function fmt(coord: number[]): string {
  const lng = coord[0]!;
  const lat = coord[1]!;
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

/** Squared planar distance from a [lng,lat(,ele)] geometry point to a Coord. */
function sqDistToCoord(point: number[], target: Coord): number {
  const dx = point[0]! - target.lng;
  const dy = point[1]! - target.lat;
  return dx * dx + dy * dy;
}

/** Index of the geometry point closest to `target`. */
function nearestIndex(coords: number[][], target: Coord): number {
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = sqDistToCoord(coords[i]!, target);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** `count` indices spread evenly across [0, length). */
function evenIndices(length: number, count: number): number[] {
  if (length <= 0 || count <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

/**
 * Pick up to `n` indices into `interior` for the Maps via-point list, GUARANTEEING
 * one index per `mustInclude` point (the nearest geometry point to it) survives,
 * then filling remaining slots by shape: repeatedly add the point furthest from
 * the chord between its neighbouring chosen points (`start`/`end` anchor the
 * two ends; they default to the first/last interior point). That pins the
 * detours Maps' own shortest-path routing would otherwise cut between vias.
 * Ascending order (route order), deduped. `excludeIndices` are skipped when
 * filling (e.g. near-start/end duplicates) but never override a forced match.
 */
export function selectWaypointIndices(
  interior: number[][],
  mustInclude: Coord[],
  n: number,
  excludeIndices: Set<number> = new Set(),
  start: number[] = interior[0] ?? [],
  end: number[] = interior[interior.length - 1] ?? [],
): number[] {
  if (interior.length === 0 || n <= 0) return [];
  const forced = new Set<number>();
  for (const point of mustInclude) forced.add(nearestIndex(interior, point));
  let forcedList = [...forced].sort((a, b) => a - b);
  if (forcedList.length > n) {
    // More forced points than slots (rare) — keep an even spread of them rather
    // than arbitrarily dropping the tail.
    forcedList = evenIndices(forcedList.length, n).map((i) => forcedList[i]!);
  }

  // Work in an extended index space with the anchors at -1 and interior.length,
  // so every interior point always sits between two chosen neighbours.
  const pointAt = (i: number) =>
    i < 0 ? start : i >= interior.length ? end : interior[i]!;
  const chosen = [-1, ...forcedList, interior.length];
  const eligible = (i: number) => !excludeIndices.has(i) && !chosen.includes(i);

  while (chosen.length - 2 < n) {
    let bestIdx = -1;
    let bestDev = -1;
    let widestIdx = -1;
    let widestGap = 0;
    for (let k = 1; k < chosen.length; k++) {
      const a = chosen[k - 1]!;
      const b = chosen[k]!;
      let gapHasCandidate = false;
      for (let i = a + 1; i < b; i++) {
        if (!eligible(i)) continue;
        gapHasCandidate = true;
        const dev = metersToSegment(pointAt(i), pointAt(a), pointAt(b));
        if (dev > bestDev) {
          bestDev = dev;
          bestIdx = i;
        }
      }
      if (gapHasCandidate && b - a > widestGap) {
        // Fallback candidate: the eligible index nearest this gap's midpoint.
        const mid = (a + b) / 2;
        let pick = -1;
        for (let i = a + 1; i < b; i++) {
          if (
            eligible(i) &&
            (pick < 0 || Math.abs(i - mid) < Math.abs(pick - mid))
          )
            pick = i;
        }
        widestGap = b - a;
        widestIdx = pick;
      }
    }
    const next = bestDev >= MIN_SHAPE_DEVIATION_M ? bestIdx : widestIdx;
    if (next < 0) break; // nothing eligible left
    chosen.push(next);
    chosen.sort((x, y) => x - y);
  }
  return chosen.slice(1, -1);
}

/**
 * Build a walking-mode Google Maps directions URL for a route candidate: origin
 * = the start point, destination = the route's last point, with a few
 * intermediate via points picked by shape (see selectWaypointIndices) so the
 * path Maps re-routes through them stays close to the route's own length. `mustInclude` (constrained "through X" waypoints) are guaranteed to
 * survive the downsampling — see selectWaypointIndices.
 */
export function candidateToMapsUrl(
  candidate: RouteCandidate,
  mustInclude: Coord[] = [],
  profile?: RouteProfile,
): string {
  const coords = candidate.coordinates;
  if (coords.length === 0) return MAPS_BASE;

  const start = coords[0]!;
  // Destination = the route's LAST point: the same as start for a loop (so the
  // link closes), or the finish for a constrained "finish near X" route.
  const end = coords[coords.length - 1]!;
  const interior = coords.slice(1, -1);
  const nearEdge = new Set<number>();
  interior.forEach((pt, i) => {
    if (
      metersBetween(pt, start) < MIN_EDGE_GAP_M ||
      metersBetween(pt, end) < MIN_EDGE_GAP_M
    ) {
      nearEdge.add(i);
    }
  });
  const vias = selectWaypointIndices(
    interior,
    mustInclude,
    MAX_WAYPOINTS,
    nearEdge,
    start,
    end,
  ).map((i) => interior[i]!);

  const qs = new URLSearchParams({
    origin: fmt(start),
    destination: fmt(end),
    travelmode: travelMode(profile),
  });
  let url = `${MAPS_BASE}&${qs.toString()}`;
  if (vias.length) {
    // waypoints is a pipe-delimited list; encode the whole value once.
    const waypoints = vias.map(fmt).join('|');
    url += `&waypoints=${encodeURIComponent(waypoints)}`;
  }
  return url;
}

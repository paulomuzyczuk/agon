import type { AreaShape, Coord } from './types';

// Distance-targeted DETOUR for constrained routes (MZY-215): "20 km, through
// Grunewald, finishing at Schloßstraße 1". A point-to-point route through the
// waypoints is whatever length it is; to hit the target we add ONE extra
// waypoint — pushed sideways off the longest leg, or pushed around inside an
// area via ("through the forest") — and search for the offset whose routed
// total lands on the target. The routed distance grows roughly monotonically
// with the offset, so a secant step (bracketed by bisection once we've over- and
// undershot) converges in 2–4 routing calls per direction.
//
// This replaced padding the route with a warm-up LOOP at the start
// (compose.ts), which for a one-way ride meant "circle home first, then go" —
// honest about distance but not the route anyone asked for. Padding is still the
// fallback when no detour lands inside tolerance (generate.ts).
//
// Pure geometry + an injected evaluator → unit-tested without a router.

const EARTH_R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineM(a: Coord, b: Coord): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b in degrees clockwise from north, [0, 360). */
export function bearingDeg(a: Coord, b: Coord): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point `meters` from `from` along `bearing` (spherical destination). */
export function offsetPoint(
  from: Coord,
  bearing: number,
  meters: number,
): Coord {
  const δ = meters / EARTH_R;
  const θ = toRad(bearing);
  const φ1 = toRad(from.lat);
  const λ1 = toRad(from.lng);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: toDeg(φ2), lng: toDeg(λ2) };
}

export function midpoint(a: Coord, b: Coord): Coord {
  // Plenty accurate for legs of a few km — no need for the spherical form.
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 };
}

/** Ray-casting point-in-ring test; ring is [lng, lat] pairs. */
function inRing(p: Coord, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    if (
      yi > p.lat !== yj > p.lat &&
      p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** True when the point lies inside any of the area's outer rings. */
export function pointInArea(p: Coord, area: AreaShape): boolean {
  return area.some((ring) => inRing(p, ring));
}

// Step for marching a ray out to the area's edge. 50 m is finer than any path
// spacing that matters for a run/ride detour; a 15 km ray is 300 cheap tests.
const RAY_STEP_M = 50;
const RAY_MAX_M = 15000;
/**
 * Outside stretches up to this long don't end the area. OSM often maps one
 * forest as several parts split by a motorway or railway (Grunewald is cut by
 * the AVUS and the S-Bahn): the route crosses those, and stopping the ray at
 * the first cut left under 1.5 km of "room" in an 8 km forest.
 */
const RAY_MAX_GAP_M = 200;

/**
 * How far (metres) one can go from `from` along `bearing` and still be inside
 * the area — the last inside point before leaving it for good (gaps up to
 * RAY_MAX_GAP_M are crossed). 0 if `from` itself is outside. Marches rather
 * than intersecting edges analytically: robust for MultiPolygons and
 * self-touching OSM rings.
 */
export function insideRunM(
  from: Coord,
  bearing: number,
  area: AreaShape,
): number {
  if (!pointInArea(from, area)) return 0;
  let lastInside = 0;
  for (let d = RAY_STEP_M; d <= RAY_MAX_M; d += RAY_STEP_M) {
    if (pointInArea(offsetPoint(from, bearing, d), area)) lastInside = d;
    else if (d - lastInside > RAY_MAX_GAP_M) break;
  }
  return lastInside;
}

/**
 * A representative point inside the area: `preferred` if it is inside, else the
 * vertex average if THAT is inside (concave shapes can put it outside), else
 * the first vertex of the largest ring. Used as the detour anchor for an area.
 */
export function interiorAnchor(area: AreaShape, preferred?: Coord): Coord {
  if (preferred && pointInArea(preferred, area)) return preferred;
  const largest = [...area].sort((a, b) => b.length - a.length)[0] ?? [];
  if (largest.length > 0) {
    const avg = {
      lng: largest.reduce((s, c) => s + c[0]!, 0) / largest.length,
      lat: largest.reduce((s, c) => s + c[1]!, 0) / largest.length,
    };
    if (pointInArea(avg, area)) return avg;
  }
  if (preferred) return preferred;
  const v = largest[0] ?? [0, 0];
  return { lng: v[0]!, lat: v[1]! };
}

/** Rough bounding-box diagonal of an area in metres (a "is this a real area?" test). */
export function areaSpanM(area: AreaShape): number {
  const pts = area.flat();
  if (pts.length === 0) return 0;
  const lngs = pts.map((p) => p[0]!);
  const lats = pts.map((p) => p[1]!);
  return haversineM(
    { lat: Math.min(...lats), lng: Math.min(...lngs) },
    { lat: Math.max(...lats), lng: Math.max(...lngs) },
  );
}

// ── Where to put the detour ──────────────────────────────────────────────────

/**
 * Street distance per metre of straight-line offset, roughly: a detour of
 * offset d adds ~2d as the crow flies, ~2.5d on a street grid. Seeds the first
 * guess only — the secant steps correct it.
 */
const DETOUR_GROWTH = 2.5;

/** A detour site: how to turn an offset (metres) into the full waypoint list. */
export interface DetourPlan {
  /** Compass bearing the detour point moves along. For reporting/diversity. */
  bearing: number;
  /** Largest useful offset (metres) — the area edge, or a sane cap. */
  maxOffsetM: number;
  /** Full waypoint list [start, …, end] for a given offset. */
  waypointsFor(offsetM: number): Coord[];
}

export interface DetourVia extends Coord {
  /** When set, the via is an AREA: the detour point stays inside it. */
  area?: AreaShape;
}

/** Compass sweep step for choosing area detour directions (degrees). */
const AREA_SWEEP_STEP = 15;
/** Area detour directions must differ by at least this much (degrees). */
const AREA_MIN_SEPARATION = 60;
/** Area detour directions tried per request (each costs ≤ MAX_DETOUR_EVALS calls). */
const AREA_MAX_PLANS = 3;
/** Room inside the area below which a direction is not worth a routing call. */
const AREA_MIN_ROOM_M = 200;

function angularGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * The detour plans to try for a waypoint list (start, …vias, end). If a via is
 * an area, its waypoint is MOVED around inside the area (the route then really
 * spends its extra distance there — "through the forest", not past its edge).
 * Which way to move is chosen by sweeping the compass: a direction must have
 * room inside the area, and is scored by how much straight-line length moving
 * that way adds. Fixed left/right-of-travel bearings failed on the real case
 * (MZY-215): Nominatim's point for Grunewald sits near the forest's Havel edge,
 * so "west" had 600 m of forest left and "east" pulled the route toward home and
 * SHORTENED it; the forest's room is north–south.
 *
 * Without an area via, an extra point is inserted at the midpoint of the
 * longest leg and pushed perpendicular to it, left and right (a "back" push
 * there would just be an out-and-back spur along the route itself).
 */
export function detourPlans(
  start: Coord,
  vias: DetourVia[],
  end: Coord,
  extraM: number,
): DetourPlan[] {
  // Plain coords only — callers pass labelled/area-carrying objects, and those
  // extra fields must not leak into provider requests.
  const plain = (c: Coord): Coord => ({ lat: c.lat, lng: c.lng });
  const points: Coord[] = [plain(start), ...vias.map(plain), plain(end)];
  // A detour adds ~2× its offset; allow generous headroom for street detours.
  const cap = Math.max(500, extraM);

  const areaIdx = vias.findIndex((v) => v.area && v.area.length > 0);
  if (areaIdx >= 0) {
    const via = vias[areaIdx]!;
    const area = via.area!;
    const anchor = plain(interiorAnchor(area, via));
    const prev = points[areaIdx]!; // point before the via (start or earlier via)
    const next = points[areaIdx + 2]!; // point after the via
    const baseLen = haversineM(prev, anchor) + haversineM(anchor, next);
    // Offset at which to compare directions: what the target needs, as far as
    // the area allows.
    const probeFor = (room: number) => Math.min(room, extraM / DETOUR_GROWTH);

    const scored: { bearing: number; room: number; gain: number }[] = [];
    for (let b = 0; b < 360; b += AREA_SWEEP_STEP) {
      const room = Math.min(cap, insideRunM(anchor, b, area) * 0.9);
      if (room < AREA_MIN_ROOM_M) continue;
      const p = offsetPoint(anchor, b, probeFor(room));
      const gain = haversineM(prev, p) + haversineM(p, next) - baseLen;
      if (gain > 0) scored.push({ bearing: b, room, gain });
    }
    scored.sort((x, y) => y.gain - x.gain);
    const chosen: typeof scored = [];
    for (const c of scored) {
      if (chosen.length >= AREA_MAX_PLANS) break;
      if (
        chosen.every(
          (k) => angularGap(k.bearing, c.bearing) >= AREA_MIN_SEPARATION,
        )
      ) {
        chosen.push(c);
      }
    }
    if (chosen.length > 0) {
      return chosen.map(({ bearing, room }) => ({
        bearing,
        maxOffsetM: room,
        waypointsFor(offsetM: number) {
          const p =
            offsetM > 0 ? offsetPoint(anchor, bearing, offsetM) : anchor;
          const out = [...points];
          out[areaIdx + 1] = p;
          return out;
        },
      }));
    }
    // No room anywhere inside (a tiny area): detour on the longest leg instead.
  }

  // Longest straight-line leg — the detour there distorts the route least.
  let leg = 0;
  let legLen = -1;
  for (let i = 0; i < points.length - 1; i++) {
    const len = haversineM(points[i]!, points[i + 1]!);
    if (len > legLen) {
      legLen = len;
      leg = i;
    }
  }
  const a = points[leg]!;
  const b = points[leg + 1]!;
  const mid = midpoint(a, b);
  // A degenerate leg (start == end, no vias) has no direction; any will do.
  const travel = legLen > 1 ? bearingDeg(a, b) : 0;
  return [travel - 90, travel + 90].map((raw) => {
    const bearing = (raw + 360) % 360;
    return {
      bearing,
      maxOffsetM: cap,
      waypointsFor(offsetM: number) {
        const p = offsetPoint(mid, bearing, offsetM);
        return [...points.slice(0, leg + 1), p, ...points.slice(leg + 1)];
      },
    };
  });
}

// ── Offset search ────────────────────────────────────────────────────────────

/** Default acceptance: within 3% of the target (well inside the ±5% ask). */
export const DETOUR_TOLERANCE = 0.03;
/** Routing calls allowed per detour direction (the ORS quota is the budget). */
export const MAX_DETOUR_EVALS = 4;

export interface OffsetEval<T> {
  offsetM: number;
  distanceM: number;
  value: T;
}

/**
 * Find the offset whose routed distance is closest to `targetM`, spending at
 * most `maxEvals` calls of `evaluate`. `baseM` is the known distance at offset
 * 0 (the plain spine — no call needed). Returns the closest evaluation, or null
 * if every call failed. Never throws on an evaluate() failure: a failed probe
 * spends its eval and the next one tries halfway back toward the last good
 * offset.
 */
export async function solveOffset<T>(
  evaluate: (offsetM: number) => Promise<{ distanceM: number; value: T }>,
  opts: {
    baseM: number;
    targetM: number;
    maxOffsetM: number;
    tolerance?: number;
    maxEvals?: number;
  },
): Promise<OffsetEval<T> | null> {
  const tol = (opts.tolerance ?? DETOUR_TOLERANCE) * opts.targetM;
  const maxEvals = opts.maxEvals ?? MAX_DETOUR_EVALS;
  if (!(opts.maxOffsetM > 0)) return null;

  // Bracket: lo = largest offset known to be short, hi = smallest known long.
  let lo = { offsetM: 0, distanceM: opts.baseM };
  let hi: { offsetM: number; distanceM: number } | null = null;
  let best: OffsetEval<T> | null = null;
  let prev = lo;

  let next = Math.min(
    opts.maxOffsetM,
    (opts.targetM - opts.baseM) / DETOUR_GROWTH,
  );
  for (let i = 0; i < maxEvals; i++) {
    if (!(next > 0)) break;
    let got: { distanceM: number; value: T };
    try {
      got = await evaluate(next);
    } catch {
      // Usually "no routable point near here" (the probe landed in a lake or a
      // fenced-off block): back off toward the last good offset and try again.
      next = (lo.offsetM + next) / 2;
      continue;
    }
    const cur = { offsetM: next, distanceM: got.distanceM };
    if (
      !best ||
      Math.abs(cur.distanceM - opts.targetM) <
        Math.abs(best.distanceM - opts.targetM)
    ) {
      best = { ...cur, value: got.value };
    }
    const err = cur.distanceM - opts.targetM;
    if (Math.abs(err) <= tol) break;

    if (err < 0) lo = cur.offsetM > lo.offsetM ? cur : lo;
    else if (!hi || cur.offsetM < hi.offsetM) hi = cur;

    // Short even at the edge of the area / cap: can't go further this way.
    if (err < 0 && cur.offsetM >= opts.maxOffsetM) break;

    // Secant through the last two probes, then keep it inside the bracket.
    const slope =
      (cur.distanceM - prev.distanceM) / (cur.offsetM - prev.offsetM || 1);
    let guess =
      slope > 0 ? cur.offsetM - err / slope : cur.offsetM * (err < 0 ? 2 : 0.5);
    const upper = hi ? hi.offsetM : opts.maxOffsetM;
    if (!(guess > lo.offsetM && guess < upper)) {
      guess = hi
        ? (lo.offsetM + hi.offsetM) / 2
        : Math.min(upper, cur.offsetM * 2);
    }
    prev = cur;
    next = guess;
  }
  return best;
}

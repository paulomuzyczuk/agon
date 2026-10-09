import type { Coord } from './types';

// Pure compass-bearing math for a route's geometry. Split out of diversity.ts so
// rank.ts (weather-weighted ranking) can use routeBearing without diversity.ts
// importing rank.ts's RankedCandidate creating a cycle — diversity.ts re-exports
// these for backwards compatibility, so existing imports are unaffected.

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** 8-point compass label for a bearing in degrees. */
export function compassDirection(bearingDeg: number): string {
  const idx = Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8;
  return DIRS[idx]!;
}

const toRad = (d: number): number => (d * Math.PI) / 180;

/** Initial bearing from `from` to `to`, degrees clockwise from north (0–360). */
export function bearingBetween(from: Coord, to: Coord): number {
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(to.lng - from.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cheap squared planar distance (equirectangular) — fine at city scale. */
function approxSqDist(from: Coord, lat: number, lng: number): number {
  const x = (lng - from.lng) * Math.cos(toRad(from.lat));
  const y = lat - from.lat;
  return x * x + y * y;
}

/** Bearing of the loop's apex (farthest point from start) — its overall heading. */
export function routeBearing(start: Coord, coordinates: number[][]): number {
  let best = -1;
  let apex: Coord = start;
  for (const c of coordinates) {
    const lng = c[0]!;
    const lat = c[1]!;
    const d = approxSqDist(start, lat, lng);
    if (d > best) {
      best = d;
      apex = { lat, lng };
    }
  }
  return bearingBetween(start, apex);
}

/** Smallest angle between two bearings (0–180). */
export function angularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

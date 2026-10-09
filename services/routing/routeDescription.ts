import { reverseGeocode } from './geocode';

// Builds a human, place-based description of a route ("Südkreuz, Tempelhof and
// Kudamm") by reverse-geocoding a few points sampled ALONG the loop. The athlete
// wanted the calendar link text to describe where each route goes, not just its
// direction. Network-bound (reverse geocoding) but resilient: any failed lookup
// is skipped, and an all-fail route falls back to an empty list so the caller can
// use a direction/distance label instead.

// Fractions along the coordinate array to sample. Interior points (not the shared
// home start/end) spread across the loop so the names trace the actual path.
const SAMPLE_FRACTIONS = [0.2, 0.5, 0.8];

/** Join names as a readable list: "A", "A and B", "A, B and C". */
export function formatVia(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Reverse-geocode sampled points along a route and return up to 3 distinct area
 * names in path order. Deduped case-insensitively; failures are skipped.
 */
export async function describeRouteVia(
  coordinates: number[][],
): Promise<string[]> {
  if (coordinates.length === 0) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const f of SAMPLE_FRACTIONS) {
    const idx = Math.min(
      coordinates.length - 1,
      Math.round(f * (coordinates.length - 1)),
    );
    const c = coordinates[idx]!;
    let name: string | null = null;
    try {
      name = await reverseGeocode({ lat: c[1]!, lng: c[0]! });
    } catch {
      // Skip a failed lookup (rate limit / miss) — keep whatever else we get.
      name = null;
    }
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

/**
 * A short, human label for one route: place-based when we could describe it
 * ("Route 1 · 8.3 km — Tempelhof, Schöneberg and Wilmersdorf"), else a compass
 * fallback ("Route 1 · 8.3 km · heading N"). A route that finishes somewhere
 * else says so ("Route 1 · 20.4 km one-way — …") — otherwise a calendar reader
 * assumes a loop and plans to end up back home.
 */
export function buildRouteLabel(
  rank: number,
  distanceKm: number,
  via: string[],
  direction?: string,
  oneWay = false,
): string {
  const head = `Route ${rank} · ${distanceKm.toFixed(1)} km${oneWay ? ' one-way' : ''}`;
  if (via.length > 0) return `${head} — ${formatVia(via)}`;
  if (direction) return `${head} · heading ${direction}`;
  return head;
}

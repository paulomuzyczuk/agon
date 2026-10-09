import { z } from 'zod';
import { areaSpanM } from './detour';
import type { AreaShape, Coord } from './types';

// Named AREA → OSM polygon, for "through Grunewald" style vias (MZY-215). The
// Pelias geocoder behind ORS returns points only, so a forest resolved to a
// single centroid and the route could merely clip its edge. Nominatim (the
// OpenStreetMap geocoder — free, keyless) returns the actual boundary with
// `polygon_geojson=1`, which detour.ts uses to keep the detour point INSIDE
// the area.
//
// Best-effort by design: any failure (network, policy block, no polygon, a
// "polygon" that is just a building footprint) returns null and the via stays
// an ordinary point, exactly as before. Usage policy (≤1 req/s, identifying
// User-Agent) is honoured — we make at most one call per area via.
// NOMINATIM_BASE_URL points at a self-hosted instance; ROUTING_AREA_LOOKUP=0
// switches the lookup off.

const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';
const USER_AGENT = 'agon-route-builder/1.0 (self-hosted personal training app)';

/** Search box half-size around the focus, degrees (~50 km in Berlin). */
const VIEWBOX_DEG = 0.5;
/**
 * Below this span a polygon is a building / plaza, not an area worth routing
 * around inside — a restaurant's footprint must stay a point via.
 */
export const MIN_AREA_SPAN_M = 500;
/**
 * OSM categories that are places you go THROUGH (forest, park, lake) rather than
 * administrative lines. "Grunewald" is both an Ortsteil (villa colony + part of
 * the forest) and the forest itself; "through Grunewald" on a run or ride means
 * the forest, so these win over a `boundary` hit of the same name.
 */
const NATURAL_CATEGORIES = new Set(['natural', 'landuse', 'leisure', 'water']);

/** Simplify the returned polygon (degrees): ~50 m, plenty for detour placement. */
const POLYGON_THRESHOLD = 0.0005;

const nominatimSchema = z.array(
  z
    .object({
      lat: z.string(),
      lon: z.string(),
      display_name: z.string().optional(),
      category: z.string().optional(),
      geojson: z
        .object({
          type: z.string(),
          coordinates: z.unknown(),
        })
        .optional(),
    })
    .passthrough(),
);

export interface AreaResult extends Coord {
  label: string;
  area: AreaShape;
}

/** Outer rings of a GeoJSON Polygon / MultiPolygon, else null. Pure. */
export function outerRings(geojson: {
  type: string;
  coordinates?: unknown;
}): AreaShape | null {
  const isRing = (r: unknown): r is number[][] =>
    Array.isArray(r) &&
    r.length >= 4 &&
    r.every(
      (p) =>
        Array.isArray(p) &&
        typeof p[0] === 'number' &&
        typeof p[1] === 'number',
    );
  if (geojson.type === 'Polygon' && Array.isArray(geojson.coordinates)) {
    const outer = geojson.coordinates[0];
    return isRing(outer) ? [outer] : null;
  }
  if (geojson.type === 'MultiPolygon' && Array.isArray(geojson.coordinates)) {
    const rings = (geojson.coordinates as unknown[])
      .map((poly) => (Array.isArray(poly) ? poly[0] : null))
      .filter(isRing);
    return rings.length ? rings : null;
  }
  return null;
}

/**
 * Resolve a place name to an area polygon near `focus`, or null when it isn't
 * an area (or the lookup fails). Never throws.
 */
export async function lookupArea(
  text: string,
  focus: Coord | null,
): Promise<AreaResult | null> {
  if (process.env.ROUTING_AREA_LOOKUP === '0') return null;
  const base = (process.env.NOMINATIM_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const qs = new URLSearchParams({
    q: text,
    format: 'jsonv2',
    polygon_geojson: '1',
    polygon_threshold: String(POLYGON_THRESHOLD),
    limit: '5',
  });
  if (focus) {
    qs.set(
      'viewbox',
      [
        focus.lng - VIEWBOX_DEG,
        focus.lat + VIEWBOX_DEG,
        focus.lng + VIEWBOX_DEG,
        focus.lat - VIEWBOX_DEG,
      ].join(','),
    );
    qs.set('bounded', '1');
  }
  try {
    const res = await fetch(`${base}/search?${qs.toString()}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const hits = nominatimSchema.parse(await res.json());
    // Stable sort: natural areas first, otherwise Nominatim's relevance order.
    const ordered = [
      ...hits.filter((h) => NATURAL_CATEGORIES.has(h.category ?? '')),
      ...hits.filter((h) => !NATURAL_CATEGORIES.has(h.category ?? '')),
    ];
    for (const h of ordered) {
      if (!h.geojson) continue;
      const area = outerRings(h.geojson);
      if (!area || areaSpanM(area) < MIN_AREA_SPAN_M) continue;
      return {
        lat: Number(h.lat),
        lng: Number(h.lon),
        // "Grunewald, Charlottenburg-Wilmersdorf, Berlin, …" → first two parts.
        label: h.display_name
          ? h.display_name.split(',').slice(0, 2).join(',').trim()
          : text,
        area,
      };
    }
    return null;
  } catch {
    return null;
  }
}

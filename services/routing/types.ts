import { z } from 'zod';

// Shared domain types for the route builder (CLAUDE.md Premium-Parity #6) plus
// zod schemas that parse the OpenRouteService responses at the boundary (sihha
// convention: validate every external payload). Kept provider-neutral — the
// domain types below name nothing ORS-specific, so a GraphHopper adapter can
// return the same RouteCandidate shape.

/** A geographic point. lat/lng in decimal degrees (WGS84). */
export interface Coord {
  lat: number;
  lng: number;
}

/**
 * A named AREA a route should pass through ("through Grunewald"): its outer
 * rings as [lng, lat] pairs (GeoJSON order). Holes are ignored — a lake inside
 * a forest still counts as "the forest" for detour placement.
 */
export type AreaShape = number[][][];

/**
 * ORS routing profile — the travel mode a loop/spine is generated for. Named
 * after ORS's own profile ids so no translation layer sits between a request
 * and the provider call. Default is 'foot-walking' everywhere (existing run
 * behaviour); 'cycling-regular' is the Premium-Parity #6 bike extension.
 * ORS has no surface parameter; its cycling profiles ARE the surface lever
 * (MZY-67): 'cycling-road' keeps to paved roads, 'cycling-mountain' accepts
 * unpaved tracks (gravel/MTB).
 */
export const ROUTE_PROFILES = [
  'foot-walking',
  'cycling-regular',
  'cycling-road',
  'cycling-mountain',
] as const;
export type RouteProfile = (typeof ROUTE_PROFILES)[number];

export function isCyclingProfile(profile: RouteProfile | undefined): boolean {
  return profile?.startsWith('cycling-') ?? false;
}

/**
 * Gradient preference for a cycling route (MZY-67) — ORS's
 * `steepness_difficulty` weighting (see orsProvider.ts). Cycling-only: ORS has
 * no gradient option for foot profiles.
 */
export const HILL_PREFERENCES = ['flat', 'hilly'] as const;
export type HillPreference = (typeof HILL_PREFERENCES)[number];

/** A request for target-distance round-trip loops from a start point. */
export interface RouteRequest {
  /** Desired loop length in kilometres. */
  targetKm: number;
  /** Where the loop starts and finishes. */
  start: Coord;
  /**
   * Distinct route shapes to generate. Each seed yields a different loop; we
   * generate a few and keep the best (rank.ts). Default in generate.ts.
   */
  seeds?: number[];
  /** ORS round_trip `points` — waypoint count shaping the loop. Default 5. */
  points?: number;
  /** Travel mode. Default 'foot-walking' (see RouteProfile). */
  profile?: RouteProfile;
  /** Gradient preference; cycling profiles only. Default: the engine's own. */
  hills?: HillPreference;
}

/** One generated candidate loop, provider-neutral. */
export interface RouteCandidate {
  /** The seed that produced this shape (for reproducibility + save). */
  seed: number;
  /** Actual loop length the engine returned, in metres. */
  distanceM: number;
  /** Total ascent in metres, or null when the engine returned no elevation. */
  elevationGainM: number | null;
  /**
   * Ordered route geometry as [lng, lat] or [lng, lat, ele] tuples — the ORS /
   * GeoJSON coordinate order. Consumed by gpx.ts and mapsLink.ts.
   */
  coordinates: number[][];
  /** Engine that produced this route, e.g. "openrouteservice". */
  provider: string;
  /**
   * Intermediate waypoints this route was actually routed through (excluding
   * start/finish), when that differs from the request's resolved vias — a
   * detour route moves an area via / adds a detour point (detour.ts). The Maps
   * link pins these so it reproduces the route. Absent for plain loops.
   */
  vias?: Coord[];
}

// ── OpenRouteService response schemas (parsed at the client boundary) ─────────

/** Pelias geocoding search response (GeoJSON FeatureCollection). */
export const orsGeocodeResponseSchema = z.object({
  features: z
    .array(
      z.object({
        geometry: z.object({
          // [lon, lat]
          coordinates: z.tuple([z.number(), z.number()]),
        }),
        // Admin fields are read to disambiguate same-named streets across
        // Bezirke ("Schloßstraße 1" exists in Steglitz AND Charlottenburg).
        properties: z
          .object({
            label: z.string().optional(),
            name: z.string().optional(),
            street: z.string().optional(),
            neighbourhood: z.string().optional(),
            borough: z.string().optional(),
            locality: z.string().optional(),
            localadmin: z.string().optional(),
            county: z.string().optional(),
            postalcode: z.string().optional(),
          })
          .passthrough(),
      }),
    )
    .default([]),
});
export type OrsGeocodeResponse = z.infer<typeof orsGeocodeResponseSchema>;

/**
 * Pelias reverse-geocoding response. We read neighbourhood/locality-level names
 * from `properties` to describe which areas a route passes through, so the fields
 * are typed loosely (all optional) and `passthrough` keeps the rest.
 */
export const orsReverseResponseSchema = z.object({
  features: z
    .array(
      z.object({
        properties: z
          .object({
            name: z.string().optional(),
            label: z.string().optional(),
            neighbourhood: z.string().optional(),
            locality: z.string().optional(),
            borough: z.string().optional(),
            localadmin: z.string().optional(),
          })
          .passthrough(),
      }),
    )
    .default([]),
});
export type OrsReverseResponse = z.infer<typeof orsReverseResponseSchema>;

/**
 * Directions response in GeoJSON form (`/v2/directions/{profile}/geojson`).
 * With `elevation: true`, geometry coordinates carry a third (altitude) element
 * and `properties.ascent`/`descent` are present.
 */
export const orsDirectionsResponseSchema = z.object({
  features: z
    .array(
      z.object({
        geometry: z.object({
          // Array of [lon, lat] or [lon, lat, ele].
          coordinates: z.array(z.array(z.number())),
        }),
        properties: z
          .object({
            summary: z.object({
              distance: z.number(), // metres
              duration: z.number(), // seconds
            }),
            ascent: z.number().optional(),
            descent: z.number().optional(),
          })
          .passthrough(),
      }),
    )
    .min(1),
});
export type OrsDirectionsResponse = z.infer<typeof orsDirectionsResponseSchema>;

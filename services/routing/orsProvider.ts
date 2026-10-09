import { orsFetch } from './client';
import type { RouteProvider } from './provider';
import {
  orsDirectionsResponseSchema,
  type RouteRequest,
  type RouteCandidate,
  type Coord,
  type RouteProfile,
  type HillPreference,
  isCyclingProfile,
} from './types';

// OpenRouteService round-trip adapter. Uses `options.round_trip` — the ORS
// feature that natively targets a distance and loops back to the start (Google
// Maps can't do this; see CLAUDE.md #6). One request per seed, since each seed
// yields a distinct loop shape. Profile (foot-walking / cycling-*) is a
// per-request parameter, not hardcoded — the same generator serves both the
// run and bike route builders (CLAUDE.md #6 cycling extension).

const DEFAULT_PROFILE: RouteProfile = 'foot-walking';
const DEFAULT_SEEDS = [1, 2, 3, 4];
const DEFAULT_POINTS = 5;

export const PROVIDER_NAME = 'openrouteservice';

// ORS `steepness_difficulty` (cycling-* only) is a fitness level, 0 novice …
// 3 pro: the preferred gradient rises with it. The extremes are the levers.
const STEEPNESS: Record<HillPreference, number> = { flat: 0, hilly: 3 };

/**
 * The profile-specific part of a directions request's `options`. ORS documents
 * `steepness_difficulty` for cycling-* profiles only, so it's never sent on foot.
 */
export function profileOptions(
  profile: RouteProfile,
  hills: HillPreference | undefined,
): Record<string, unknown> {
  if (!hills || !isCyclingProfile(profile)) return {};
  return {
    profile_params: {
      weightings: { steepness_difficulty: STEEPNESS[hills] },
    },
  };
}

/** Total ascent for a candidate: prefer ORS's `ascent`, else sum positive
 *  altitude deltas along the 3D coordinates, else null (no elevation data). */
export function elevationGain(
  ascent: number | undefined,
  coordinates: number[][],
): number | null {
  if (typeof ascent === 'number') return Math.round(ascent);
  const hasEle = coordinates.every((c) => c.length >= 3);
  if (!hasEle || coordinates.length < 2) return null;
  let gain = 0;
  for (let i = 1; i < coordinates.length; i++) {
    const delta = coordinates[i]![2]! - coordinates[i - 1]![2]!;
    if (delta > 0) gain += delta;
  }
  return Math.round(gain);
}

async function roundTripForSeed(
  req: RouteRequest,
  seed: number,
): Promise<RouteCandidate> {
  const profile = req.profile ?? DEFAULT_PROFILE;
  const res = await orsFetch(`/v2/directions/${profile}/geojson`, {
    method: 'POST',
    body: JSON.stringify({
      coordinates: [[req.start.lng, req.start.lat]],
      elevation: true,
      instructions: false,
      options: {
        ...profileOptions(profile, req.hills),
        round_trip: {
          length: Math.round(req.targetKm * 1000), // metres
          points: req.points ?? DEFAULT_POINTS,
          seed,
        },
      },
    }),
  });
  const parsed = orsDirectionsResponseSchema.parse(await res.json());
  const feature = parsed.features[0];
  if (!feature)
    throw new Error('openrouteservice: directions response had no features');
  const coordinates = feature.geometry.coordinates;
  return {
    seed,
    distanceM: feature.properties.summary.distance,
    elevationGainM: elevationGain(feature.properties.ascent, coordinates),
    coordinates,
    provider: PROVIDER_NAME,
  };
}

/** Point-to-point route through waypoints (the spine for constrained routes). */
async function directionsThrough(
  waypoints: Coord[],
  profile: RouteProfile = DEFAULT_PROFILE,
  hills?: HillPreference,
): Promise<RouteCandidate> {
  if (waypoints.length < 2) {
    throw new Error('openrouteservice: directions needs at least 2 waypoints');
  }
  const options = profileOptions(profile, hills);
  const res = await orsFetch(`/v2/directions/${profile}/geojson`, {
    method: 'POST',
    body: JSON.stringify({
      coordinates: waypoints.map((w) => [w.lng, w.lat]),
      // Snap each waypoint to the nearest routable way however far it is. The
      // 350 m default rejected geocoded POIs inside parks and detour points
      // that land in a lake or forest interior (detour.ts) with error 2010.
      radiuses: waypoints.map(() => -1),
      elevation: true,
      instructions: false,
      ...(Object.keys(options).length ? { options } : {}),
    }),
  });
  const parsed = orsDirectionsResponseSchema.parse(await res.json());
  const feature = parsed.features[0];
  if (!feature)
    throw new Error('openrouteservice: directions response had no features');
  const coordinates = feature.geometry.coordinates;
  return {
    seed: 0, // a spine has no shape variation
    distanceM: feature.properties.summary.distance,
    elevationGainM: elevationGain(feature.properties.ascent, coordinates),
    coordinates,
    provider: PROVIDER_NAME,
  };
}

export const orsProvider: RouteProvider = {
  name: PROVIDER_NAME,
  async generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]> {
    const seeds = req.seeds ?? DEFAULT_SEEDS;
    // Sequential (not Promise.all) so one 429 stops the burst instead of firing
    // every seed into the rate limit at once — the free tier is ~40 req/min.
    const out: RouteCandidate[] = [];
    for (const seed of seeds) {
      out.push(await roundTripForSeed(req, seed));
    }
    return out;
  },
  directions: directionsThrough,
};

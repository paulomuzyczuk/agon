import { z } from 'zod';
import type { RouteProvider } from './provider';
import {
  isCyclingProfile,
  type Coord,
  type RouteCandidate,
  type RouteProfile,
} from './types';

// Fallback point-to-point router: the FOSSGIS-hosted OSRM instances behind
// routing.openstreetmap.de (the router openstreetmap.org itself uses — free,
// keyless, same OSM data as ORS). Point-to-point ONLY: OSRM has no
// target-length round_trip, so loops stay ORS-only. Exists because ORS's free
// directions quota runs out by mid-morning on a heavy day (MZY-215), and a
// detour search spends several directions calls per candidate.
//
// FOSSGIS runs one server per mode (routed-foot / routed-bike); the profile
// segment in the path is always "driving" by their convention. Every cycling
// profile maps to routed-bike, and a hill preference is ignored: OSRM has
// neither surface variants nor a gradient option. No elevation in OSRM
// responses → elevationGainM is null (ranking treats that as unknown).
// OSRM_BASE_URL overrides the host (e.g. a self-hosted OSRM).

const DEFAULT_BASE_URL = 'https://routing.openstreetmap.de';
export const OSRM_PROVIDER_NAME = 'osrm';

// FOSSGIS usage policy: ≤1 request/second, identifying User-Agent.
const MIN_INTERVAL_MS = 1000;
const USER_AGENT = 'agon-route-builder/1.0 (self-hosted personal training app)';

const osrmRouteSchema = z.object({
  code: z.string(),
  message: z.string().optional(),
  routes: z
    .array(
      z.object({
        distance: z.number(), // metres
        geometry: z.object({ coordinates: z.array(z.array(z.number())) }),
      }),
    )
    .default([]),
});

function serviceFor(profile: RouteProfile): string {
  return isCyclingProfile(profile) ? 'routed-bike' : 'routed-foot';
}

let lastCallAt = 0;
async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

async function directions(
  waypoints: Coord[],
  profile: RouteProfile = 'foot-walking',
): Promise<RouteCandidate> {
  if (waypoints.length < 2) {
    throw new Error('osrm: directions needs at least 2 waypoints');
  }
  const base = (process.env.OSRM_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  const coords = waypoints.map((w) => `${w.lng},${w.lat}`).join(';');
  const url =
    `${base}/${serviceFor(profile)}/route/v1/driving/${coords}` +
    '?overview=full&geometries=geojson&steps=false';
  await throttle();
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`osrm: route failed (${res.status}) ${text}`);
  }
  const parsed = osrmRouteSchema.parse(await res.json());
  const route = parsed.routes[0];
  if (parsed.code !== 'Ok' || !route) {
    throw new Error(`osrm: ${parsed.code} ${parsed.message ?? ''}`.trim());
  }
  return {
    seed: 0,
    distanceM: route.distance,
    elevationGainM: null,
    coordinates: route.geometry.coordinates,
    provider: OSRM_PROVIDER_NAME,
  };
}

export const osrmProvider: RouteProvider = {
  name: OSRM_PROVIDER_NAME,
  async generateRoundTrips(): Promise<RouteCandidate[]> {
    throw new Error(
      'osrm: round trips are not supported (use openrouteservice)',
    );
  },
  directions,
};

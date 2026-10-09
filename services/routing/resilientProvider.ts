import { OrsRateLimitError } from './client';
import type { RouteProvider } from './provider';
import type {
  Coord,
  HillPreference,
  RouteCandidate,
  RouteProfile,
} from './types';

// Provider decorators for point-to-point `directions` (MZY-215):
//   • withDirectionsFallback — when the primary engine is rate-limited / out of
//     quota, answer from a secondary engine instead of failing the request.
//   • withDirectionsCache — memoise identical directions calls. A detour search
//     re-routes the same legs, and the long-lived MCP server gets the same
//     "20 km to X" asked twice; neither should spend quota twice.
// Round trips pass straight through both (only ORS can target a loop length).

/** Is this error "the engine said no more requests", worth falling back on? */
export function isQuotaError(err: unknown): boolean {
  return err instanceof OrsRateLimitError;
}

export function withDirectionsFallback(
  primary: RouteProvider,
  fallback: RouteProvider,
  shouldFallback: (err: unknown) => boolean = isQuotaError,
): RouteProvider {
  // Once the primary is out of quota it stays out for hours; stop asking it for
  // the rest of this process instead of burning a failed call per leg.
  let primaryExhausted = false;
  return {
    name: primary.name,
    generateRoundTrips: (req) => primary.generateRoundTrips(req),
    async directions(
      waypoints: Coord[],
      profile?: RouteProfile,
      hills?: HillPreference,
    ): Promise<RouteCandidate> {
      if (!primaryExhausted) {
        try {
          return await primary.directions(waypoints, profile, hills);
        } catch (err) {
          if (!shouldFallback(err)) throw err;
          primaryExhausted = true;
        }
      }
      return fallback.directions(waypoints, profile, hills);
    },
  };
}

/** ~1 m precision — two requests this close are the same request. */
function key(
  waypoints: Coord[],
  profile: RouteProfile | undefined,
  hills: HillPreference | undefined,
): string {
  return `${profile ?? 'foot-walking'}|${hills ?? ''}|${waypoints
    .map((w) => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`)
    .join(';')}`;
}

export function withDirectionsCache(
  inner: RouteProvider,
  maxEntries = 200,
): RouteProvider {
  const cache = new Map<string, RouteCandidate>();
  return {
    name: inner.name,
    generateRoundTrips: (req) => inner.generateRoundTrips(req),
    async directions(
      waypoints: Coord[],
      profile?: RouteProfile,
      hills?: HillPreference,
    ): Promise<RouteCandidate> {
      const k = key(waypoints, profile, hills);
      const hit = cache.get(k);
      if (hit) return hit;
      const route = await inner.directions(waypoints, profile, hills);
      if (cache.size >= maxEntries) {
        // Map iterates in insertion order → drop the oldest entry.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(k, route);
      return route;
    },
  };
}

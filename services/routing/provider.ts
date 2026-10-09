import type {
  RouteRequest,
  RouteCandidate,
  Coord,
  RouteProfile,
  HillPreference,
} from './types';

// The one swap point (CLAUDE.md: route ingestion is "provider-neutral by
// construction"). A RouteProvider knows how to generate target-distance loops
// for one routing engine; generate.ts and the MCP tool depend only on this
// interface, so adding GraphHopper — or a self-hosted ORS — is one new file.

export interface RouteProvider {
  /** Engine id stamped onto every candidate, e.g. "openrouteservice". */
  readonly name: string;
  /**
   * Generate one candidate loop per seed in the request (or per the provider's
   * default seeds). Ranking + trimming to the top N happens in rank.ts, not here.
   */
  generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]>;
  /**
   * Point-to-point route through the given waypoints in order. The "spine" for
   * constrained routes (through X / finish near Y) — it honours the waypoints
   * but returns whatever distance that takes (no target). The `seed` on the
   * returned candidate is 0 (a spine has no shape variation). Profile defaults
   * to 'foot-walking'. `hills` is a best-effort preference: an engine with no
   * gradient option ignores it.
   */
  directions(
    waypoints: Coord[],
    profile?: RouteProfile,
    hills?: HillPreference,
  ): Promise<RouteCandidate>;
}

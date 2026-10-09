// Public surface of the route builder (CLAUDE.md Premium-Parity #6). Mirrors the
// index.ts of the other services/ adapters. Provider-neutral: the generation and
// artifact helpers name nothing ORS-specific.

export type {
  Coord,
  RouteRequest,
  RouteCandidate,
  RouteProfile,
  HillPreference,
  AreaShape,
} from './types';
export { isCyclingProfile, ROUTE_PROFILES, HILL_PREFERENCES } from './types';

export type { RouteProvider } from './provider';

export { orsProvider, PROVIDER_NAME, elevationGain } from './orsProvider';

export {
  orsFetch,
  orsBaseUrl,
  orsApiKey,
  OrsRateLimitError,
  OrsConfigError,
} from './client';

export {
  geocode,
  reverseGeocode,
  transliterateUmlauts,
  type GeocodeResult,
} from './geocode';
export { homeLocation } from './config';

export {
  selectDiverse,
  compassDirection,
  routeBearing,
  type DiverseCandidate,
} from './diversity';

export {
  describeRouteVia,
  formatVia,
  buildRouteLabel,
} from './routeDescription';

export {
  suggestRoutes,
  type StartInput,
  type ResolvedPoint,
  type SuggestRoutesInput,
  type SuggestRoutesResult,
} from './generate';

export { stitchLoopAndSpine, spineAsCandidate, MIN_PAD_M } from './compose';
export { detourPlans, solveOffset, DETOUR_TOLERANCE } from './detour';
export { lookupArea, type AreaResult } from './area';
export { osrmProvider, OSRM_PROVIDER_NAME } from './osrmProvider';
export {
  withDirectionsFallback,
  withDirectionsCache,
} from './resilientProvider';

export { rankCandidates, type RankedCandidate } from './rank';
export { candidateToGpx, type GpxOptions } from './gpx';
export {
  candidateToMapsUrl,
  downsample,
  selectWaypointIndices,
} from './mapsLink';

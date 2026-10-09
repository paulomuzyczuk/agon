import { geocode } from './geocode';
import { homeLocation } from './config';
import { orsProvider } from './orsProvider';
import { osrmProvider } from './osrmProvider';
import {
  withDirectionsCache,
  withDirectionsFallback,
} from './resilientProvider';
import { lookupArea } from './area';
import { detourPlans, haversineM, interiorAnchor, solveOffset } from './detour';
import { rankCandidates, DISTANCE_BAND, type RankedCandidate } from './rank';
import { selectDiverse } from './diversity';
import { stitchLoopAndSpine, MIN_PAD_M } from './compose';
import {
  calibratedRequestKm,
  closerToTarget,
  needsCalibration,
  DEFAULT_TOLERANCE,
} from './calibrate';
import { heatCaveat, type RouteForecast } from './weather';
import { fetchRouteForecast } from '../weather/openMeteo';
import type { RouteProvider } from './provider';
import type {
  AreaShape,
  Coord,
  HillPreference,
  RouteCandidate,
  RouteProfile,
} from './types';

// Seed pool for diverse selection — more shapes to choose 3 different directions
// from than a plain top-N would offer.
const DEFAULT_DIVERSE_SEEDS = [1, 2, 3, 4, 5, 6];
// Non-diverse default: a few distinct shapes to rank.
const DEFAULT_SEEDS = [1, 2, 3];
// Only diversify among loops reasonably close to the target (±30%); a wildly
// off-distance loop heading a novel direction isn't a useful suggestion.
const DIVERSE_DISTANCE_TOLERANCE = 0.3;

// Orchestrates a route-suggestion request. Two shapes:
//   • Unconstrained — target-distance LOOPS from a start (ORS round_trip).
//   • Constrained — "pass through X / finish at Y": a point-to-point spine
//     through the waypoints, stretched to the target distance by a DETOUR
//     waypoint (detour.ts) — pushed off the longest leg, or moved around inside
//     an area via ("through Grunewald"). A few detour directions give a few
//     candidates. Only when no detour lands near the target does it fall back to
//     padding the spine with a round_trip loop at the start (compose.ts).
// Provider is injectable so a GraphHopper / self-hosted-ORS swap — or a unit test
// with a fake provider — needs no change here. Pure of DB: persistence + artifact
// rendering (GPX / Maps link / labels) are the caller's job.

/**
 * A point in a request: explicit coords, a place to geocode, or home. A coord
 * may carry an `area` (outer rings) to mark a via as an area to route through.
 */
export type StartInput =
  { coord: Coord; area?: AreaShape } | { place: string } | { home: true };

export interface SuggestRoutesInput {
  targetKm: number;
  start?: StartInput; // default: home
  /** Waypoints the route must pass through, in order (constrained route). */
  through?: StartInput[];
  /** Where the route finishes (constrained route). Default: back at the start. */
  finishNear?: StartInput;
  seeds?: number[];
  points?: number;
  /** Travel mode. Default 'foot-walking' — pass a 'cycling-*' profile for a bike loop. */
  profile?: RouteProfile;
  /** Gradient preference, cycling profiles only (see HillPreference). */
  hills?: HillPreference;
  keep?: number; // default 3
  /**
   * Select the kept routes for DIRECTIONAL diversity (spread across the compass)
   * rather than purely by distance accuracy. Generates a larger seed pool.
   */
  diverse?: boolean;
  /**
   * Weight ranking by the day's forecast wind exposure (see weather.ts), and
   * surface a heat caveat when hot. Default false — every existing caller (the
   * calendar sync's per-run loop generation, the MCP tool) keeps its current
   * behaviour and cost (one extra Open-Meteo call per suggestRoutes()) unless it
   * opts in. Best-effort: a forecast fetch failure never fails the request, it
   * just ranks without a wind tiebreak (same as `weather: false`).
   */
  weather?: boolean;
  /** Instant to fetch the forecast for, when `weather` is true. Default: now. */
  weatherAtISO?: string;
}

export type ResolvedPoint = Coord & {
  label: string;
  /** Set on a via that resolved to an AREA (a forest, a park, a district). */
  area?: AreaShape;
  /** The geocoder's doubt that this is the place meant (see geocode.ts). */
  warning?: string;
};

export interface SuggestRoutesResult {
  start: ResolvedPoint;
  /** Resolved waypoints (constrained route only). */
  through?: ResolvedPoint[];
  /** Resolved finish (constrained route only; else the loop returns to start). */
  finish?: ResolvedPoint;
  /** True when the spine alone already met/exceeded the target (no padding added). */
  spineOnly?: boolean;
  /** True when the route finishes somewhere other than where it starts. */
  oneWay?: boolean;
  targetKm: number;
  /** Travel mode used to generate these candidates (see mapsLink.ts's travel-mode mapping). */
  profile: RouteProfile;
  candidates: RankedCandidate[];
  /** Heat caveat text when `weather` was requested and the forecast is hot; else null. */
  heatCaveat?: string | null;
  /**
   * Low-confidence place resolutions (start / through / finish), for the caller
   * to show — a via that geocoded to the wrong venue must not route silently.
   */
  geocodeWarnings?: string[];
}

/**
 * Best-effort forecast fetch for ranking — never throws. Mirrors the "a routing
 * failure degrades gracefully, never fails the whole request" posture used
 * elsewhere in this module (geocode fallbacks, calendar-push failures, etc).
 */
async function fetchWeatherForRanking(
  start: Coord,
  atISO: string | undefined,
): Promise<RouteForecast | null> {
  try {
    return await fetchRouteForecast(
      start.lat,
      start.lng,
      atISO ?? new Date().toISOString(),
    );
  } catch {
    return null;
  }
}

async function resolvePoint(
  input: StartInput,
  focus?: Coord | null,
): Promise<ResolvedPoint> {
  if ('home' in input) return { ...homeLocation(), label: 'home' };
  if ('coord' in input) {
    return { ...input.coord, label: `${input.coord.lat},${input.coord.lng}` };
  }
  const hit = await geocode(input.place, focus);
  if (!hit) {
    throw new Error(`routing: could not geocode location "${input.place}"`);
  }
  return {
    lat: hit.lat,
    lng: hit.lng,
    label: hit.label,
    ...(hit.warning ? { warning: hit.warning } : {}),
  };
}

/** Distinct warnings — a loop's finish IS its start, so it would repeat. */
function warningsOf(points: ResolvedPoint[]): string[] | undefined {
  const out = [...new Set(points.flatMap((p) => p.warning ?? []))];
  return out.length > 0 ? out : undefined;
}

/**
 * Resolve a VIA: a place name is first tried as an area (OSM polygon, so a
 * detour can stay inside it), then as a plain point. Explicit coords pass any
 * given `area` through.
 */
async function resolveVia(
  input: StartInput,
  focus: Coord,
): Promise<ResolvedPoint> {
  if ('coord' in input && input.area) {
    return {
      ...interiorAnchor(input.area, input.coord),
      label: `${input.coord.lat},${input.coord.lng}`,
      area: input.area,
    };
  }
  if ('place' in input) {
    const area = await lookupArea(input.place, focus);
    if (area) {
      return {
        ...interiorAnchor(area.area, area),
        label: area.label,
        area: area.area,
      };
    }
  }
  return resolvePoint(input, focus);
}

async function resolveStart(
  start: StartInput | undefined,
): Promise<ResolvedPoint> {
  return resolvePoint(start ?? { home: true });
}

/**
 * Extra correction rounds allowed per off-target seed. One round fixes the
 * ordinary overshoot; the second rescues a seed whose first attempt was so wild
 * that the correction had to be clamped (a 7.5 km ask returning a 39 km loop
 * clamps to a 0.25× request, which then undershoots and needs one more pass).
 */
const MAX_CALIBRATION_ROUNDS = 2;

/**
 * Generate round-trip loops, then re-request any that missed the target length
 * by more than `tolerance` with a corrected length (see calibrate.ts). Costs
 * extra provider calls only for seeds whose previous attempt was off, so a
 * well-behaved area (dense street grid) pays nothing.
 */
async function generateCalibratedLoops(
  provider: RouteProvider,
  req: {
    targetKm: number;
    start: Coord;
    seeds?: number[];
    points?: number;
    profile?: RouteProfile;
    hills?: HillPreference;
  },
  tolerance: number = DEFAULT_TOLERANCE,
): Promise<RouteCandidate[]> {
  const first = await provider.generateRoundTrips(req);

  const out: RouteCandidate[] = [];
  for (const candidate of first) {
    let best = candidate;
    let requestedKm = req.targetKm;

    for (let round = 0; round < MAX_CALIBRATION_ROUNDS; round++) {
      const actualKm = best.distanceM / 1000;
      if (!needsCalibration(actualKm, req.targetKm, tolerance)) break;
      const nextKm = calibratedRequestKm(requestedKm, actualKm, req.targetKm);
      if (nextKm === null) break;
      // Re-ask for this seed alone at the corrected length; keep whichever
      // attempt landed closer. A failed retry must never lose what we had.
      try {
        const retry = await provider.generateRoundTrips({
          ...req,
          targetKm: nextKm,
          seeds: [best.seed],
        });
        if (!retry[0]) break;
        const adopted = closerToTarget(best, retry[0], req.targetKm);
        // If the retry didn't improve things, another round would recompute the
        // same correction from the same base — stop instead of spending a call.
        if (adopted === best) break;
        best = adopted;
        requestedKm = nextKm;
      } catch {
        break;
      }
    }
    out.push(best);
  }
  return out;
}

/** Rank (and optionally diversify) candidates down to the top `keep`. */
function selectCandidates(
  candidates: RouteCandidate[],
  targetKm: number,
  keep: number,
  diverse: boolean,
  start: Coord,
  weather?: { start: Coord; forecast: RouteForecast | null },
): RankedCandidate[] {
  if (!diverse) return rankCandidates(candidates, targetKm, keep, weather);
  const all = rankCandidates(candidates, targetKm, candidates.length, weather);
  const tol = targetKm * 1000 * DIVERSE_DISTANCE_TOLERANCE;
  const within = all.filter((c) => c.distanceErrorM <= tol);
  if (within.length >= keep) return selectDiverse(within, start, keep);

  // Too few on-target shapes to diversify among. Earlier this fell back to the
  // FULL candidate list, which let directional spread override distance
  // entirely — a 12 km request came back with 12.4 km, 6.2 km and 5.7 km loops
  // because the short ones happened to head different ways. Keep every
  // on-target route instead and top up with the next-closest, so an unusual
  // area degrades to "accurate but samey" rather than "varied but wrong length".
  const chosen = [...within];
  for (const c of all) {
    if (chosen.length >= keep) break;
    if (!chosen.includes(c)) chosen.push(c);
  }
  return selectDiverse(chosen, start, keep);
}

/**
 * Beyond this, a finish counts as "somewhere else" (one-way) rather than a
 * finish back at the start that merely geocoded a few doors down.
 */
const ONE_WAY_MIN_M = 300;
/**
 * Once some detour is on target, others further off than this are dropped
 * rather than offered as alternatives.
 */
const MAX_DETOUR_ERROR = 0.15;
/** Detour candidates get seeds from here, distinct from pad-loop seeds 1–6. */
const DETOUR_SEED_BASE = 100;

/**
 * Stretch the spine to the target with a detour waypoint, once per detour
 * direction (see detour.ts). Sequential: every probe is a directions call and
 * the ORS quota is the budget.
 */
async function generateDetours(
  provider: RouteProvider,
  start: Coord,
  vias: ResolvedPoint[],
  finish: Coord,
  spine: RouteCandidate,
  targetM: number,
  profile: RouteProfile,
  hills: HillPreference | undefined,
): Promise<RouteCandidate[]> {
  const plans = detourPlans(start, vias, finish, targetM - spine.distanceM);
  const out: RouteCandidate[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]!;
    const best = await solveOffset(
      async (offsetM) => {
        const waypoints = plan.waypointsFor(offsetM);
        const route = await provider.directions(waypoints, profile, hills);
        return { distanceM: route.distanceM, value: { route, waypoints } };
      },
      { baseM: spine.distanceM, targetM, maxOffsetM: plan.maxOffsetM },
    );
    if (!best) continue;
    out.push({
      ...best.value.route,
      seed: DETOUR_SEED_BASE + i + 1,
      vias: best.value.waypoints.slice(1, -1),
    });
  }
  return out;
}

// Directions go to ORS, then FOSSGIS OSRM once ORS is out of quota, through a
// per-process cache (the MCP server is long-lived). ROUTING_FALLBACK_OSRM=0
// keeps ORS as the only engine.
let defaultProviderMemo: RouteProvider | null = null;
function defaultProvider(): RouteProvider {
  if (!defaultProviderMemo) {
    const base =
      process.env.ROUTING_FALLBACK_OSRM === '0'
        ? orsProvider
        : withDirectionsFallback(orsProvider, osrmProvider);
    defaultProviderMemo = withDirectionsCache(base);
  }
  return defaultProviderMemo;
}

export async function suggestRoutes(
  input: SuggestRoutesInput,
  provider: RouteProvider = defaultProvider(),
): Promise<SuggestRoutesResult> {
  if (!(input.targetKm > 0)) {
    throw new Error('routing: targetKm must be a positive number');
  }
  const start = await resolveStart(input.start);
  const keep = input.keep ?? 3;
  const profile: RouteProfile = input.profile ?? 'foot-walking';
  const hills = input.hills;
  const startCoord = { lat: start.lat, lng: start.lng };
  const constrained =
    (input.through && input.through.length > 0) || !!input.finishNear;

  const forecast = input.weather
    ? await fetchWeatherForRanking(startCoord, input.weatherAtISO)
    : null;
  const weather = input.weather ? { start: startCoord, forecast } : undefined;
  const heat = input.weather ? heatCaveat(forecast) : undefined;

  if (!constrained) {
    const seeds =
      input.seeds ?? (input.diverse ? DEFAULT_DIVERSE_SEEDS : DEFAULT_SEEDS);
    const candidates = await generateCalibratedLoops(provider, {
      targetKm: input.targetKm,
      start: startCoord,
      seeds,
      points: input.points,
      profile,
      hills,
    });
    const ranked = selectCandidates(
      candidates,
      input.targetKm,
      keep,
      !!input.diverse,
      startCoord,
      weather,
    );
    return {
      start,
      targetKm: input.targetKm,
      profile,
      candidates: ranked,
      heatCaveat: heat,
      geocodeWarnings: warningsOf([start]),
    };
  }

  // ── Constrained: spine through the waypoints, padded to the target distance ──
  // Waypoints geocode with the START as the bias point, not the athlete's home:
  // "finish near the marina" means the marina near where this run begins.
  const through: ResolvedPoint[] = [];
  for (const t of input.through ?? []) {
    through.push(await resolveVia(t, startCoord));
  }
  const finish = input.finishNear
    ? await resolvePoint(input.finishNear, startCoord)
    : start;
  const finishCoord = { lat: finish.lat, lng: finish.lng };
  const oneWay = haversineM(startCoord, finishCoord) > ONE_WAY_MIN_M;

  const spine = await provider.directions(
    [
      startCoord,
      ...through.map((p) => ({ lat: p.lat, lng: p.lng })),
      { lat: finish.lat, lng: finish.lng },
    ],
    profile,
    hills,
  );

  const targetM = input.targetKm * 1000;
  const padM = targetM - spine.distanceM;

  if (padM < MIN_PAD_M) {
    // The through/finish route already meets (or exceeds) the target — return it
    // alone; the caller surfaces that we couldn't pad it further.
    const ranked = rankCandidates([spine], input.targetKm, keep, weather);
    return {
      start,
      through,
      finish,
      spineOnly: true,
      oneWay,
      targetKm: input.targetKm,
      profile,
      candidates: ranked,
      heatCaveat: heat,
      geocodeWarnings: warningsOf([start, ...through, finish]),
    };
  }

  const candidates = await generateDetours(
    provider,
    startCoord,
    through,
    finishCoord,
    spine,
    targetM,
    profile,
    hills,
  );

  // No detour landed near the target (area too small to hold the extra
  // distance, sparse street graph …): add the pad-loop composition too and let
  // ranking pick. Costs round-trip calls only in that case.
  const onTarget = candidates.some(
    (c) => Math.abs(c.distanceM - targetM) <= targetM * DISTANCE_BAND,
  );
  if (onTarget) {
    // A detour direction that ran out of room (hit the area's edge) can land
    // far short — a 9 km "suggestion" for a 20 km ask is noise next to an
    // on-target one, so drop it rather than pad the list.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const err = Math.abs(candidates[i]!.distanceM - targetM) / targetM;
      if (err > MAX_DETOUR_ERROR) candidates.splice(i, 1);
    }
  } else {
    const seeds =
      input.seeds ?? (input.diverse ? DEFAULT_DIVERSE_SEEDS : DEFAULT_SEEDS);
    try {
      const loops = await generateCalibratedLoops(provider, {
        targetKm: padM / 1000,
        start: startCoord,
        seeds,
        points: input.points,
        profile,
        hills,
      });
      candidates.push(...loops.map((loop) => stitchLoopAndSpine(loop, spine)));
    } catch (err) {
      // Round trips are ORS-only; out of quota they fail. Keep any detours.
      if (candidates.length === 0) throw err;
    }
  }
  const ranked = selectCandidates(
    candidates,
    input.targetKm,
    keep,
    !!input.diverse,
    startCoord,
    weather,
  );
  return {
    start,
    through,
    finish,
    oneWay,
    targetKm: input.targetKm,
    profile,
    candidates: ranked,
    heatCaveat: heat,
    geocodeWarnings: warningsOf([start, ...through, finish]),
  };
}

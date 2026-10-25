import {
  suggestRoutes,
  type RouteProfile,
  type SuggestRoutesResult,
} from '../routing';
import { homeLocationOrNull, workLocationOrNull } from '../routing/config';
import { commuteLegOf, type CommuteLeg } from '../../lib/training/commutes';
import { countCrossings } from '../routing/crossings';
import { outAndBackFrom } from '../routing/outAndBack';
import {
  pickTimeTrialRoute,
  timeTrialLabelSuffix,
  withinTimeTrialDistance,
  type ScoredCandidate,
} from '../routing/timeTrialPick';
import type { RankedCandidate } from '../routing/rank';
import { getAthleteProfile } from '../../lib/athleteProfile';
import { describeRouteVia, buildRouteLabel } from '../routing/routeDescription';
import {
  saveSuggestionBatch,
  getAttachedRoutes,
  clearAttachedRoutes,
  attachSuggestionToPlannedSession,
  type AttachedRoute,
} from '../routeSuggestions';
import {
  BIKE_ASSUMED_DURATION_MIN,
  EASY_BIKE_SPEED_KMH,
} from '../../lib/constants';
import { detailHasOwnRoute } from '../../lib/calendarDetail';
import type { CalendarSyncRow } from '../plannedSessions';
import type { EventRouteInfo } from './eventMap';

/** Map a persisted route to the event-description shape (shared by auto + adhoc). */
export function attachedRouteToEventInfo(
  r: AttachedRoute,
  index: number,
): EventRouteInfo {
  const km = r.distanceM / 1000;
  return {
    mapsUrl: r.mapsUrl,
    distanceKm: km,
    elevationGainM: r.elevationGainM,
    direction: r.direction ?? undefined,
    label:
      r.viaLabel ??
      buildRouteLabel(index + 1, km, [], r.direction ?? undefined),
  };
}

// Bridges the route builder into the calendar sync: for a run or bike planned
// session, ensure a set of suggested loops from home exists and return them
// (with place-based labels) for the event description. REUSE-first — an
// already-attached set is returned as-is (stable event, no repeat API calls);
// otherwise generate DIRECTIONALLY DIVERSE loops, describe each by the areas it
// passes through, persist, and attach them to the session (the
// planned-vs-actual composition). Bike sessions use the cycling-regular ORS
// profile (services/routing/orsProvider.ts) instead of the run default.

// Show three significantly different routes per session (athlete's request).
const ROUTES_PER_SESSION = 3;

/**
 * A bike session carries no target distance in planned_sessions (runs have
 * targetDistanceKm; bike is duration-based only).
 * Infer a loop distance from the same flat duration the calendar sync assumes
 * for the event block × an easy Zone-2 cycling speed (lib/constants.ts) —
 * documented, not hardcoded here, so both places stay in sync.
 */
function inferBikeTargetKm(): number {
  return (BIKE_ASSUMED_DURATION_MIN / 60) * EASY_BIKE_SPEED_KMH;
}

// Commute rides are one-way, home ↔ work (lib/training/commutes.ts). Route 1 is
// always the direct (fastest) ride; the others are the same ride stretched by a
// detour. Mornings stay close to direct — getting to work is the point — while
// evenings may wander (athlete's request, 2026-10-15).
const COMMUTE_STRETCH: Record<CommuteLeg, number> = {
  commute_to_work: 1.12,
  commute_home: 1.5,
};
// A variant within this fraction of the direct ride's length is the direct ride
// again (a stretch too small to detour returns the spine itself).
const SAME_ROUTE_FRACTION = 0.02;

// Time trials get ONE route, picked on traffic lights from a wider pool: plain
// loops from home plus loops through each profile `timeTrialVia` place.
const TIME_TRIAL_LOOP_POOL = 5;
const TIME_TRIAL_VIA_POOL = 3;

/** Deps seam so the sync can be unit-tested without the routing API or a DB. */
export interface RouteForSessionDeps {
  getAttached: typeof getAttachedRoutes;
  clearAttached: typeof clearAttachedRoutes;
  generate: typeof suggestRoutes;
  describeVia: typeof describeRouteVia;
  save: typeof saveSuggestionBatch;
  attach: typeof attachSuggestionToPlannedSession;
  /** Commute endpoints; null when the env doesn't set them. */
  home: () => ReturnType<typeof homeLocationOrNull>;
  work: () => ReturnType<typeof workLocationOrNull>;
  countCrossings: typeof countCrossings;
  /** Places a time-trial loop may route through (athlete profile). */
  timeTrialVias: () => string[];
  /** Where a time trial of this distance turns around, or null for a loop. */
  timeTrialTurnaround: (targetKm: number) => string | null;
}

const defaultDeps: RouteForSessionDeps = {
  getAttached: getAttachedRoutes,
  clearAttached: clearAttachedRoutes,
  generate: suggestRoutes,
  describeVia: describeRouteVia,
  save: saveSuggestionBatch,
  attach: attachSuggestionToPlannedSession,
  home: homeLocationOrNull,
  work: workLocationOrNull,
  countCrossings,
  timeTrialVias: () => getAthleteProfile().timeTrialVia ?? [],
  timeTrialTurnaround: (targetKm) =>
    getAthleteProfile().timeTrialOutAndBack?.[String(targetKm)] ?? null,
};

/**
 * One-way commute candidates: the direct ride first, then up to two detoured
 * variants (see COMMUTE_STRETCH). Null when home or work isn't configured.
 */
async function generateCommuteRoutes(
  leg: CommuteLeg,
  deps: RouteForSessionDeps,
): Promise<SuggestRoutesResult | null> {
  const home = deps.home();
  const work = deps.work();
  if (!home || !work) return null;
  const [from, to] = leg === 'commute_to_work' ? [home, work] : [work, home];
  const base = {
    start: { coord: from },
    finishNear: { coord: to },
    profile: 'cycling-regular' as const,
  };
  // A target below the direct distance returns the direct route alone.
  const direct = await deps.generate({ ...base, targetKm: 0.1, keep: 1 });
  const spine = direct.candidates[0];
  if (!spine) return null;
  const variants = await deps.generate({
    ...base,
    targetKm: (spine.distanceM / 1000) * COMMUTE_STRETCH[leg],
    keep: ROUTES_PER_SESSION - 1,
    diverse: true,
  });
  const distinct = variants.candidates.filter(
    (c) =>
      Math.abs(c.distanceM - spine.distanceM) >
      spine.distanceM * SAME_ROUTE_FRACTION,
  );
  return { ...variants, candidates: [spine, ...distinct] };
}

/**
 * Resolve the suggested routes for a session, or [] when it doesn't apply (not a
 * run or bike session, or — for a run — no target distance to size a loop; bike
 * sessions always have an inferred one, see inferBikeTargetKm). Runs from the
 * athlete's home default. Errors propagate — the sync wraps this so a routing
 * failure degrades to "no links", never a failed calendar sync.
 */
export async function ensureRoutesForSession(
  session: CalendarSyncRow,
  deps: RouteForSessionDeps = defaultDeps,
): Promise<EventRouteInfo[]> {
  if (session.sessionKind !== 'run' && session.sessionKind !== 'bike') {
    return [];
  }
  // A hand-written route in the session's detail is the athlete's own route
  // for it (MZY-262): don't pile auto loops from home on top of it.
  if (detailHasOwnRoute(session.detail)) return [];
  const leg =
    session.sessionKind === 'bike'
      ? commuteLegOf(session.targetSessionType)
      : null;
  if (leg) return ensureCommuteRoutes(session, leg, deps);
  const targetKm = loopTargetKm(session);
  if (!targetKm || targetKm <= 0) return [];
  if (session.targetSessionType === 'time_trial') {
    return ensureTimeTrialRoute(session, targetKm, deps);
  }
  return ensureLoopRoutes(session, targetKm, deps);
}

/** A loop's size: the session's distance, or a ride's inferred one. */
function loopTargetKm(session: CalendarSyncRow): number | null {
  return session.sessionKind === 'bike'
    ? (session.targetDistanceKm ?? inferBikeTargetKm())
    : session.targetDistanceKm;
}

/**
 * True when every attached route was generated for this target. Routes with
 * no recorded request size are trusted.
 */
function fitsTarget(existing: AttachedRoute[], targetKm: number): boolean {
  return existing.every(
    (r) => r.requestedKm == null || Math.abs(r.requestedKm - targetKm) < 0.01,
  );
}

/** Three directionally diverse loops from home, for a run or a training ride. */
async function ensureLoopRoutes(
  session: CalendarSyncRow,
  targetKm: number,
  deps: RouteForSessionDeps,
): Promise<EventRouteInfo[]> {
  const profile: RouteProfile =
    session.sessionKind === 'bike' ? 'cycling-regular' : 'foot-walking';

  // Reuse an existing AUTO set once it's already the desired size (idempotent
  // re-sync) AND it was generated for the session's current target. A target the
  // athlete hand-edited in the calendar ("hand edits win", reconciled into the
  // session's resolved target) makes the old set stale — regenerate it for the
  // edited distance. Routes with no recorded request size are trusted as before.
  // Ad-hoc routes on the same session are a separate kind, untouched.
  const existing = await deps.getAttached(session.id, 'auto');
  if (existing.length >= ROUTES_PER_SESSION && fitsTarget(existing, targetKm)) {
    return existing.slice(0, ROUTES_PER_SESSION).map(attachedRouteToEventInfo);
  }

  // Generate a fresh diverse set BEFORE clearing the stale AUTO attachments
  // (clear defaults to kind 'auto', so ad-hoc routes are preserved): if routing
  // fails (e.g. ORS quota exhausted) the throw leaves the old set attached, so a
  // re-sync degrades to "old links", never "no links".
  const result = await deps.generate({
    targetKm,
    keep: ROUTES_PER_SESSION,
    diverse: true,
    profile,
  });
  if (result.candidates.length === 0) return [];
  await deps.clearAttached(session.id);

  // Describe each route by the areas it passes through (reverse geocoding).
  const labels: string[] = [];
  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i]!;
    const via = await deps.describeVia(c.coordinates);
    labels.push(buildRouteLabel(i + 1, c.distanceM / 1000, via, c.direction));
  }

  return persistAndAttach(session, result, labels, deps);
}

/**
 * The single route for a time trial: reuse it while it still fits the target,
 * else generate a pool, count each candidate's crossings and keep the best
 * (services/routing/timeTrialPick.ts). A via that fails to route only shrinks
 * the pool; a failed plain-loop generation throws like any other route.
 */
async function ensureTimeTrialRoute(
  session: CalendarSyncRow,
  targetKm: number,
  deps: RouteForSessionDeps,
): Promise<EventRouteInfo[]> {
  const turnaround = deps.timeTrialTurnaround(targetKm);
  if (turnaround)
    return ensureOutAndBackRoute(session, targetKm, turnaround, deps);

  // A route picked before the distance gate existed may be far off the target
  // (1.9 km for a 10 km trial, 2026-10-16); treat it as stale so it's replaced.
  const existing = await deps.getAttached(session.id, 'auto');
  if (
    existing.length === 1 &&
    fitsTarget(existing, targetKm) &&
    withinTimeTrialDistance(existing[0]!.distanceM, targetKm)
  ) {
    return existing.map(attachedRouteToEventInfo);
  }

  const pool: { candidate: RankedCandidate; result: SuggestRoutesResult }[] =
    [];
  const add = (result: SuggestRoutesResult) =>
    pool.push(...result.candidates.map((candidate) => ({ candidate, result })));
  add(
    await deps.generate({
      targetKm,
      keep: TIME_TRIAL_LOOP_POOL,
      diverse: true,
    }),
  );
  for (const via of deps.timeTrialVias()) {
    try {
      add(
        await deps.generate({
          targetKm,
          through: [{ place: via }],
          keep: TIME_TRIAL_VIA_POOL,
          diverse: true,
        }),
      );
    } catch {
      // an unroutable via just contributes no candidates
    }
  }
  if (pool.length === 0) return [];

  const scored: (ScoredCandidate & { result: SuggestRoutesResult })[] = [];
  for (const p of pool) {
    scored.push({
      ...p,
      crossings: await deps.countCrossings(p.candidate.coordinates),
    });
  }
  const best = pickTimeTrialRoute(scored, targetKm);
  if (!best) return [];
  await deps.clearAttached(session.id);

  const c = best.candidate;
  const via = await deps.describeVia(c.coordinates);
  const label =
    `${buildRouteLabel(1, c.distanceM / 1000, via, c.direction)} · ` +
    timeTrialLabelSuffix(best, targetKm);
  return persistAndAttach(
    session,
    { ...best.result, candidates: [c] },
    [label],
    deps,
  );
}

const OUT_AND_BACK_MARK = 'out-and-back';

/**
 * A time trial as a straight out-and-back from home to `place` and back, with
 * the turnaround set half the trial distance out (athlete's request,
 * 2026-10-22: no warm-up or cool-down in the course, just the trial). A loop
 * attached earlier is replaced; one already out-and-back for this target stays.
 */
async function ensureOutAndBackRoute(
  session: CalendarSyncRow,
  targetKm: number,
  place: string,
  deps: RouteForSessionDeps,
): Promise<EventRouteInfo[]> {
  const existing = await deps.getAttached(session.id, 'auto');
  if (
    existing.length === 1 &&
    fitsTarget(existing, targetKm) &&
    existing[0]!.viaLabel?.includes(OUT_AND_BACK_MARK)
  ) {
    return existing.map(attachedRouteToEventInfo);
  }

  // Home → the place, one way. A target below the distance returns that route
  // alone (the same trick as the commute spine); outAndBackFrom() then cuts it
  // at the half-way mark.
  const result = await deps.generate({
    targetKm: 0.1,
    through: [{ place }],
    finishNear: { place },
    keep: 1,
  });
  const spine = result.candidates[0];
  if (!spine) return [];
  if (spine.distanceM * 2 < targetKm * 1000 * 0.9) {
    throw new Error(
      `timeTrialOutAndBack: "${place}" is ${(spine.distanceM / 1000).toFixed(1)} km from home, ` +
        `too near for an out-and-back of ${targetKm} km`,
    );
  }

  const trial = outAndBackFrom(spine, targetKm * 1000);
  const { turnaround, ...rest } = trial;
  const candidate: RankedCandidate = {
    ...rest,
    distanceErrorM: Math.abs(trial.distanceM - targetKm * 1000),
    elevationGainPerKmM: null,
    vias: [turnaround],
  };
  await deps.clearAttached(session.id);
  const label =
    `Route 1 · ${(candidate.distanceM / 1000).toFixed(1)} km ${OUT_AND_BACK_MARK} ` +
    `— ${place.split(',')[0]} and back`;
  return persistAndAttach(
    session,
    { ...result, candidates: [candidate], oneWay: false },
    [label],
    deps,
  );
}

/**
 * The commute twin of the loop path above: reuse any attached set (a commute
 * has no target distance to go stale against), else generate, describe, persist
 * and attach the one-way routes.
 */
async function ensureCommuteRoutes(
  session: CalendarSyncRow,
  leg: CommuteLeg,
  deps: RouteForSessionDeps,
): Promise<EventRouteInfo[]> {
  const existing = await deps.getAttached(session.id, 'auto');
  if (existing.length > 0) {
    return existing.slice(0, ROUTES_PER_SESSION).map(attachedRouteToEventInfo);
  }
  const result = await generateCommuteRoutes(leg, deps);
  if (!result || result.candidates.length === 0) return [];

  const labels: string[] = [];
  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i]!;
    const via = await deps.describeVia(c.coordinates);
    const label = buildRouteLabel(
      i + 1,
      c.distanceM / 1000,
      via,
      c.direction,
      true,
    );
    labels.push(i === 0 ? `${label} (fastest)` : label);
  }
  return persistAndAttach(session, result, labels, deps);
}

/** Save a generated set, attach it to the session, and shape it for the event. */
async function persistAndAttach(
  session: CalendarSyncRow,
  result: SuggestRoutesResult,
  labels: string[],
  deps: RouteForSessionDeps,
): Promise<EventRouteInfo[]> {
  const { suggestions } = await deps.save(result, { labels });
  const infos: EventRouteInfo[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i]!;
    if (!s.mapsUrl) continue;
    await deps.attach(s.id, session.id);
    infos.push({
      mapsUrl: s.mapsUrl,
      distanceKm: s.distanceM / 1000,
      elevationGainM: s.elevationGainM,
      direction: s.direction ?? undefined,
      label: labels[i] ?? undefined,
    });
  }
  return infos;
}

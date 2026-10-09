import { suggestRoutes, type RouteProfile } from '../routing';
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

/** Deps seam so the sync can be unit-tested without the routing API or a DB. */
export interface RouteForSessionDeps {
  getAttached: typeof getAttachedRoutes;
  clearAttached: typeof clearAttachedRoutes;
  generate: typeof suggestRoutes;
  describeVia: typeof describeRouteVia;
  save: typeof saveSuggestionBatch;
  attach: typeof attachSuggestionToPlannedSession;
}

const defaultDeps: RouteForSessionDeps = {
  getAttached: getAttachedRoutes,
  clearAttached: clearAttachedRoutes,
  generate: suggestRoutes,
  describeVia: describeRouteVia,
  save: saveSuggestionBatch,
  attach: attachSuggestionToPlannedSession,
};

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
  const isBike = session.sessionKind === 'bike';
  // A hand-written route in the session's detail is the athlete's own route
  // for it (MZY-262): don't pile auto loops from home on top of it.
  if (detailHasOwnRoute(session.detail)) return [];
  const targetKm = isBike
    ? (session.targetDistanceKm ?? inferBikeTargetKm())
    : session.targetDistanceKm;
  if (!targetKm || targetKm <= 0) return [];
  const profile: RouteProfile = isBike ? 'cycling-regular' : 'foot-walking';

  // Reuse an existing AUTO set once it's already the desired size (idempotent
  // re-sync) AND it was generated for the session's current target. A target the
  // athlete hand-edited in the calendar ("hand edits win", reconciled into the
  // session's resolved target) makes the old set stale — regenerate it for the
  // edited distance. Routes with no recorded request size are trusted as before.
  // Ad-hoc routes on the same session are a separate kind, untouched.
  const existing = await deps.getAttached(session.id, 'auto');
  const sizedForTarget = existing.every(
    (r) => r.requestedKm == null || Math.abs(r.requestedKm - targetKm) < 0.01,
  );
  if (existing.length >= ROUTES_PER_SESSION && sizedForTarget) {
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

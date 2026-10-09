import { suggestRoutes } from './routing';
import type { HillPreference, RouteProfile } from './routing/types';
import { describeRouteVia, buildRouteLabel } from './routing/routeDescription';
import {
  saveSuggestionBatch,
  attachSuggestionToPlannedSession,
  getAttachedRoutes,
} from './routeSuggestions';
import {
  getRunSessionForDate,
  upsertAdHocRunSession,
  type CalendarSyncRow,
} from './plannedSessions';
import { attachedRouteToEventInfo } from './googleCalendar/routeForSession';
import { upsertSessionEvent } from './googleCalendar/upsertEvent';
import type { EventRouteInfo } from './googleCalendar/eventMap';

// Ad-hoc route request (CLAUDE.md #6) — the engine behind Telegram /route. Turns
// "25 km through X finishing near Y on <date>" into a constrained route (see
// services/routing/compose.ts), persists it as kind='adhoc', attaches it to that
// day's run session (creating a lightweight one if none is planned), and patches
// the calendar event so it appears under the "🧭 Ad hoc routes" section right
// away. Idempotent-friendly: re-requesting a day accumulates ad-hoc routes.

const ROUTES_PER_ADHOC = 3;

export interface AddAdHocRouteInput {
  dateISO: string;
  targetKm: number;
  /** Place names to pass through (geocoded), in order. */
  through?: string[];
  /** Place name to finish near (geocoded). */
  finishNear?: string;
  /** Travel mode. Default 'foot-walking' (existing behaviour). */
  profile?: RouteProfile;
  /** Gradient preference, cycling profiles only. */
  hills?: HillPreference;
}

export interface AddAdHocRouteResult {
  /** True if we created a lightweight run session (no run was planned that day). */
  sessionCreated: boolean;
  /** Resolved through-labels + finish-label for the reply. */
  throughLabels: string[];
  finishLabel?: string;
  /** True if the through/finish route already met the target (no padding loop). */
  spineOnly: boolean;
  /** Low-confidence place resolutions to show the athlete (see geocode.ts). */
  geocodeWarnings: string[];
  /** The newly added ad-hoc routes (with labels + Maps links). */
  routes: EventRouteInfo[];
  /** Whether the calendar event was updated (false if the calendar push failed). */
  calendarUpdated: boolean;
}

/** Injectable seams so the orchestration is unit-testable with no network/DB. */
export interface AddAdHocRouteDeps {
  findRunSession: typeof getRunSessionForDate;
  createRunSession: typeof upsertAdHocRunSession;
  generate: typeof suggestRoutes;
  describeVia: typeof describeRouteVia;
  save: typeof saveSuggestionBatch;
  attach: typeof attachSuggestionToPlannedSession;
  getAttached: typeof getAttachedRoutes;
  upsertEvent: (
    session: CalendarSyncRow,
    routes: { routes: EventRouteInfo[]; adHocRoutes: EventRouteInfo[] },
  ) => Promise<void>;
}

const defaultDeps: AddAdHocRouteDeps = {
  findRunSession: getRunSessionForDate,
  createRunSession: upsertAdHocRunSession,
  generate: suggestRoutes,
  describeVia: describeRouteVia,
  save: saveSuggestionBatch,
  attach: attachSuggestionToPlannedSession,
  getAttached: getAttachedRoutes,
  upsertEvent: upsertSessionEvent,
};

export async function addAdHocRoute(
  input: AddAdHocRouteInput,
  deps: AddAdHocRouteDeps = defaultDeps,
): Promise<AddAdHocRouteResult> {
  if (!(input.targetKm > 0)) {
    throw new Error('adhoc route: targetKm must be positive');
  }

  // Attach to that day's planned run, or create a lightweight ad-hoc run session.
  let session = await deps.findRunSession(input.dateISO);
  let sessionCreated = false;
  if (!session) {
    session = await deps.createRunSession(input.dateISO, input.targetKm);
    sessionCreated = true;
  }

  // Generate the constrained route.
  const result = await deps.generate({
    targetKm: input.targetKm,
    through: input.through?.map((place) => ({ place })),
    finishNear: input.finishNear ? { place: input.finishNear } : undefined,
    keep: ROUTES_PER_ADHOC,
    diverse: true,
    profile: input.profile,
    hills: input.hills,
  });

  // Describe + label each candidate (place names it passes through).
  const labels: string[] = [];
  for (let i = 0; i < result.candidates.length; i++) {
    const c = result.candidates[i]!;
    const via = await deps.describeVia(c.coordinates);
    labels.push(
      buildRouteLabel(
        i + 1,
        c.distanceM / 1000,
        via,
        c.direction,
        result.oneWay ?? false,
      ),
    );
  }

  // Persist as ad-hoc and attach to the session.
  const { suggestions } = await deps.save(result, { labels, kind: 'adhoc' });
  for (const s of suggestions) {
    if (s.mapsUrl) await deps.attach(s.id, session.id);
  }

  // Rebuild the event with BOTH sections preserved, and push it.
  const autoRoutes = (await deps.getAttached(session.id, 'auto')).map(
    attachedRouteToEventInfo,
  );
  const adHocRoutes = (await deps.getAttached(session.id, 'adhoc')).map(
    attachedRouteToEventInfo,
  );
  let calendarUpdated = true;
  try {
    await deps.upsertEvent(session, { routes: autoRoutes, adHocRoutes });
  } catch {
    // Persisted fine; the calendar push failed (auth/network) — it'll appear on
    // the next `pnpm gcal:sync`. Don't fail the whole request.
    calendarUpdated = false;
  }

  const newRoutes = suggestions
    .filter((s) => s.mapsUrl)
    .map((s, i) =>
      attachedRouteToEventInfo(
        {
          mapsUrl: s.mapsUrl,
          distanceM: s.distanceM,
          elevationGainM: s.elevationGainM,
          direction: s.direction,
          viaLabel: s.viaLabel,
          kind: 'adhoc',
        },
        i,
      ),
    );

  return {
    sessionCreated,
    throughLabels: result.through?.map((t) => t.label) ?? [],
    finishLabel:
      result.finish && result.finish.label !== result.start.label
        ? result.finish.label
        : undefined,
    spineOnly: result.spineOnly ?? false,
    geocodeWarnings: result.geocodeWarnings ?? [],
    routes: newRoutes,
    calendarUpdated,
  };
}

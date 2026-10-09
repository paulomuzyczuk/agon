import { query } from './db';
import type { RankedCandidate } from './routing/rank';
import { candidateToGpx } from './routing/gpx';
import { candidateToMapsUrl } from './routing/mapsLink';
import type { SuggestRoutesResult } from './routing/generate';

// Persistence for the route builder (CLAUDE.md #6). The MCP tool stays
// read-only; these writes run from the CLIs (`pnpm route:suggest --save`,
// `pnpm route:attach`) with the normal writer role. A saved batch is the set of
// candidates from one suggestRoutes call, sharing a batch_id; one of them may
// later be attached to a planned_sessions row.

/** 'auto' = the loops attached to a run event; 'adhoc' = a /route request. */
export type RouteKind = 'auto' | 'adhoc';

export interface SavedRouteSuggestion {
  id: string;
  batchId: string;
  rank: number;
  seed: number;
  distanceM: number;
  elevationGainM: number | null;
  provider: string;
  gpx: string;
  mapsUrl: string;
  direction: string | null;
  viaLabel: string | null;
  kind: RouteKind;
  plannedSessionId: string | null;
}

/** Optional per-candidate extras (aligned to result.candidates by index). */
export interface SaveSuggestionExtras {
  /** Place-based label for each route ("Route 1 · 8.3 km — Tempelhof …"). */
  labels?: (string | null)[];
  /** Whether this batch is auto (calendar loops) or adhoc (/route). Default auto. */
  kind?: RouteKind;
}

/**
 * Persist a whole suggestion batch (all ranked candidates from one call) and
 * return the saved rows in rank order. GPX + Maps link are rendered here so the
 * stored artifacts match exactly what was shown. batch_id ties the set together.
 * `extras.labels` caches the computed via-labels so re-syncs don't re-geocode.
 */
export async function saveSuggestionBatch(
  result: SuggestRoutesResult,
  extras: SaveSuggestionExtras = {},
): Promise<{ batchId: string; suggestions: SavedRouteSuggestion[] }> {
  // One batch_id for the set — generated DB-side so callers stay Date/random-free.
  const { rows: idRows } = await query<{ batch_id: string }>(
    'SELECT gen_random_uuid() AS batch_id',
  );
  const batchId = idRows[0]!.batch_id;
  const kind: RouteKind = extras.kind ?? 'auto';

  const saved: SavedRouteSuggestion[] = [];
  for (let i = 0; i < result.candidates.length; i++) {
    const c: RankedCandidate = result.candidates[i]!;
    const rank = i + 1;
    const gpx = candidateToGpx(c, {
      name: `Agon ${result.targetKm} km ${result.oneWay ? 'one-way route' : 'loop'} #${rank}`,
      description: result.oneWay
        ? `from ${result.start.label} to ${result.finish?.label ?? '?'}`
        : `from ${result.start.label}`,
    });
    // Pin the waypoints this route was actually routed through (a detour moves
    // or adds one), else the requested vias.
    const mapsUrl = candidateToMapsUrl(
      c,
      c.vias ?? result.through ?? [],
      result.profile,
    );
    const direction = c.direction ?? null;
    const viaLabel = extras.labels?.[i] ?? null;
    const { rows } = await query<{ id: string }>(
      `INSERT INTO public.route_suggestions
         (batch_id, requested_km, start_lat, start_lng, start_label,
          provider, seed, rank, distance_m, elevation_gain_m, geometry, gpx, maps_url,
          direction, via_label, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        batchId,
        result.targetKm,
        result.start.lat,
        result.start.lng,
        result.start.label,
        c.provider,
        c.seed,
        rank,
        c.distanceM,
        c.elevationGainM,
        JSON.stringify(c.coordinates),
        gpx,
        mapsUrl,
        direction,
        viaLabel,
        kind,
      ],
    );
    saved.push({
      id: rows[0]!.id,
      batchId,
      rank,
      seed: c.seed,
      distanceM: c.distanceM,
      elevationGainM: c.elevationGainM,
      provider: c.provider,
      gpx,
      mapsUrl,
      direction,
      viaLabel,
      kind,
      plannedSessionId: null,
    });
  }
  return { batchId, suggestions: saved };
}

/** Fetch one saved suggestion by id (for the attach CLI / GPX export). */
export async function getSuggestion(
  id: string,
): Promise<SavedRouteSuggestion | null> {
  const { rows } = await query<{
    id: string;
    batch_id: string;
    rank: number;
    seed: number;
    distance_m: number;
    elevation_gain_m: number | null;
    provider: string;
    gpx: string;
    maps_url: string | null;
    direction: string | null;
    via_label: string | null;
    kind: RouteKind;
    planned_session_id: string | null;
  }>(
    `SELECT id, batch_id, rank, seed, distance_m, elevation_gain_m, provider,
            gpx, maps_url, direction, via_label, kind, planned_session_id
       FROM public.route_suggestions WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    batchId: r.batch_id,
    rank: r.rank,
    seed: r.seed,
    distanceM: r.distance_m,
    elevationGainM: r.elevation_gain_m,
    provider: r.provider,
    gpx: r.gpx,
    mapsUrl: r.maps_url ?? '',
    direction: r.direction,
    viaLabel: r.via_label,
    kind: r.kind,
    plannedSessionId: r.planned_session_id,
  };
}

/** One attached route as surfaced to the calendar description. */
export interface AttachedRoute {
  mapsUrl: string;
  distanceM: number;
  elevationGainM: number | null;
  direction: string | null;
  viaLabel: string | null;
  kind: RouteKind;
  /** The distance the route was generated for (km) — lets a re-sync spot routes
   *  sized for a target the athlete has since hand-edited. */
  requestedKm?: number | null;
}

/**
 * Routes attached to a planned session, in rank order, optionally filtered by
 * kind. Lets the calendar sync REUSE already-generated routes instead of hitting
 * the routing API again on every re-sync — the event description stays stable.
 */
export async function getAttachedRoutes(
  plannedSessionId: string,
  kind?: RouteKind,
): Promise<AttachedRoute[]> {
  const { rows } = await query<{
    maps_url: string | null;
    distance_m: number;
    elevation_gain_m: number | null;
    direction: string | null;
    via_label: string | null;
    kind: RouteKind;
    requested_km: string | null;
  }>(
    `SELECT maps_url, distance_m, elevation_gain_m, direction, via_label, kind,
            requested_km
       FROM public.route_suggestions
      WHERE planned_session_id = $1
        AND ($2::text IS NULL OR kind = $2)
      ORDER BY rank, created_at`,
    [plannedSessionId, kind ?? null],
  );
  return rows.map((r) => ({
    mapsUrl: r.maps_url ?? '',
    distanceM: r.distance_m,
    elevationGainM: r.elevation_gain_m,
    direction: r.direction,
    viaLabel: r.via_label,
    kind: r.kind,
    requestedKm: r.requested_km == null ? null : Number(r.requested_km),
  }));
}

/**
 * Detach + delete route suggestions attached to a planned session — used when
 * regenerating a fresh auto set. Defaults to clearing ONLY 'auto' routes so an
 * auto regeneration never wipes the athlete's ad-hoc routes. Unattached
 * interactive saves are untouched.
 */
export async function clearAttachedRoutes(
  plannedSessionId: string,
  kind: RouteKind = 'auto',
): Promise<void> {
  await query(
    `DELETE FROM public.route_suggestions
      WHERE planned_session_id = $1 AND kind = $2`,
    [plannedSessionId, kind],
  );
}

/**
 * Attach a saved suggestion to a planned session (the planned-vs-actual
 * composition). Verifies both rows exist, sets the FK, and returns the linked
 * planned session's date/kind for a confirming message. Idempotent: re-attaching
 * the same pair is a no-op update.
 */
export async function attachSuggestionToPlannedSession(
  suggestionId: string,
  plannedSessionId: string,
): Promise<{ plannedDate: string; sessionKind: string }> {
  const { rows: planned } = await query<{
    date: string;
    session_kind: string;
  }>(
    `SELECT to_char(date,'YYYY-MM-DD') AS date, session_kind
       FROM public.planned_sessions WHERE id = $1`,
    [plannedSessionId],
  );
  if (!planned[0]) {
    throw new Error(
      `route attach: no planned_session with id ${plannedSessionId}`,
    );
  }
  const { rowCount } = await query(
    `UPDATE public.route_suggestions
        SET planned_session_id = $2
      WHERE id = $1`,
    [suggestionId, plannedSessionId],
  );
  if (!rowCount) {
    throw new Error(
      `route attach: no route_suggestion with id ${suggestionId}`,
    );
  }
  return { plannedDate: planned[0].date, sessionKind: planned[0].session_kind };
}

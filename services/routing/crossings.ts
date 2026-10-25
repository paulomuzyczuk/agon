import { z } from 'zod';
import { haversineM } from './detour';

// Counts the traffic lights and plain street crossings along a route, from
// OpenStreetMap via the Overpass API (free, keyless; ODbL — credited in
// CREDITS.md). Time-trial routes are picked on this (asked 2026-10-15): every
// red light is a stop the trial's time can't account for.
//
// Privacy: the route's first and last END_TRIM_M are cut before the line leaves
// the machine. Time-trial loops start and finish at home, so an untrimmed line
// would hand a third party the athlete's address; the trimmed stretch is shared
// by every candidate, so dropping it doesn't change which route wins.
//
// OVERPASS_BASE_URL points at a self-hosted instance; ROUTING_CROSSINGS=0
// disables counting (time trials then fall back to the ordinary ranking).

const DEFAULT_BASE_URL = 'https://overpass-api.de/api';
const USER_AGENT = 'agon-route-builder/1.0 (self-hosted personal training app)';
// A signal mapped on the far side of a junction sits ~10 m off the footway.
const SIGNAL_RADIUS_M = 12;
const CROSSING_RADIUS_M = 8;
const END_TRIM_M = 300;
// Overpass takes the polyline inline; thin long routes to keep the query small.
const MAX_QUERY_POINTS = 150;
const RETRIES = 3;
const RETRY_BASE_MS = 5_000;

/** Coordinates are [lng, lat], as everywhere in services/routing. */
type LngLat = [number, number] | number[];

export interface CrossingCounts {
  /** Traffic-light nodes (junction signals and signalised crossings). */
  trafficSignals: number;
  /** Unsignalised crossings (zebra, uncontrolled) — slower, but no red light. */
  plainCrossings: number;
}

/**
 * Drop the first and last `trimM` metres of a line. Returns [] when the line
 * is too short to have anything left. Pure.
 */
export function trimEnds(coords: LngLat[], trimM = END_TRIM_M): LngLat[] {
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    const [aLng, aLat] = coords[i - 1]!;
    const [bLng, bLat] = coords[i]!;
    cum.push(
      cum[i - 1]! +
        haversineM({ lat: aLat!, lng: aLng! }, { lat: bLat!, lng: bLng! }),
    );
  }
  const total = cum[cum.length - 1] ?? 0;
  return coords.filter((_, i) => cum[i]! >= trimM && cum[i]! <= total - trimM);
}

/** Every k-th point (and the last), so at most `max` points remain. Pure. */
function thin(coords: LngLat[], max: number): LngLat[] {
  if (coords.length <= max) return coords;
  const step = Math.ceil(coords.length / (max - 1));
  const out = coords.filter((_, i) => i % step === 0);
  out.push(coords[coords.length - 1]!);
  return out;
}

/**
 * Overpass QL counting signals, then unsignalised crossings, along the line.
 * Returns null when nothing is left to query. Pure.
 */
export function buildCrossingsQuery(coords: LngLat[]): string | null {
  const line = thin(trimEnds(coords), MAX_QUERY_POINTS);
  if (line.length < 2) return null;
  const poly = line
    .map(([lng, lat]) => `${lat!.toFixed(5)},${lng!.toFixed(5)}`)
    .join(',');
  return [
    '[out:json][timeout:60];',
    `node(around:${SIGNAL_RADIUS_M},${poly})[highway=traffic_signals]->.a;`,
    `node(around:${SIGNAL_RADIUS_M},${poly})[crossing=traffic_signals]->.b;`,
    '(.a;.b;)->.sig;',
    `node(around:${CROSSING_RADIUS_M},${poly})[highway=crossing]->.x;`,
    '(.x; - .sig;)->.plain;',
    '.sig out count;',
    '.plain out count;',
  ].join('');
}

const countResponseSchema = z.object({
  elements: z
    .array(
      z.object({
        type: z.literal('count'),
        tags: z.object({ nodes: z.coerce.number().int().nonnegative() }),
      }),
    )
    .length(2),
});

/** The two `out count` results, in query order. Throws on any other shape. */
export function parseCrossingCounts(json: unknown): CrossingCounts {
  const { elements } = countResponseSchema.parse(json);
  return {
    trafficSignals: elements[0]!.tags.nodes,
    plainCrossings: elements[1]!.tags.nodes,
  };
}

export interface CountCrossingsDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Crossing counts for a route, or null when counting is disabled, the route is
 * too short, or Overpass can't answer after retries. Never throws — a missing
 * count just means the route is ranked without it.
 */
export async function countCrossings(
  coords: LngLat[],
  deps: CountCrossingsDeps = {},
): Promise<CrossingCounts | null> {
  if (process.env.ROUTING_CROSSINGS === '0') return null;
  const query = buildCrossingsQuery(coords);
  if (!query) return null;
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = (process.env.OVERPASS_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const counts = await requestCounts(fetchFn, `${base}/interpreter`, query);
    if (counts) return counts;
    if (attempt < RETRIES - 1) await sleep(RETRY_BASE_MS * (attempt + 1));
  }
  return null;
}

/** One Overpass round trip: the counts, or null on any failure. */
async function requestCounts(
  fetchFn: typeof fetch,
  url: string,
  query: string,
): Promise<CrossingCounts | null> {
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    // Overpass answers overload with 429/504 — or a 200 HTML error page.
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trimStart().startsWith('{')) return null;
    return parseCrossingCounts(JSON.parse(text));
  } catch {
    return null; // network error or unexpected shape
  }
}

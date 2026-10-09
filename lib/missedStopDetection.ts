// Missed-stop detection (MZY-254), pure + unit-tested. The athlete sometimes
// forgets to stop the recording after getting home: the activity then ends in
// a tail of GPS drift or pottering about that inflates elapsed time and can
// add distance and moving time (2026-09-29 ride 2: 64 m at ~1.4 km/h over the
// last 3 min, trimmed by hand).
//
// Heuristic: walk back from the last GPS sample while every sample stays
// inside a small radius of an anchor — home (high confidence) or, failing
// that, the final position itself (low confidence: a café, the gym). Inside
// that zone, the cut is placed where the athlete slowed down: the last sample
// whose rolling speed was still above `slowSpeedMps`. The tail after the cut
// is flagged when it is long enough and slow enough to not be real activity.
// A genuine cool-down walk home moves toward home, so it spends little time
// inside the radius and doesn't qualify.
//
// Suggestions only — applying one is the MZY-253 late-stop trim, which cuts
// at max(time_s) − trimS, the same point as `cutAtS` here.

export interface LatLng {
  lat: number;
  lng: number;
}

export interface DetectionStream {
  timeS: number[];
  lat: Array<number | null>;
  lng: Array<number | null>;
  distanceM: Array<number | null> | null;
  moving: Array<boolean | null> | null;
}

export interface DetectionParams {
  /** Radius around home for a high-confidence tail (m). */
  homeRadiusM: number;
  /** Radius around the final position for a low-confidence (away) tail (m). */
  awayRadiusM: number;
  /** Rolling speed below which the athlete counts as stopped/pottering (m/s). */
  slowSpeedMps: number;
  /** Window for the rolling speed (s). */
  speedWindowS: number;
  /** Shortest tail worth flagging (s). */
  minTailS: number;
  /** Mean speed over the flagged tail must stay below this (m/s). */
  maxTailSpeedMps: number;
  /**
   * Minimum impact: the tail must cover at least this distance (m) OR carry
   * at least `minTailMovingS` moving seconds — otherwise trimming it changes
   * no total (duration_s is moving time) and isn't worth a suggestion.
   */
  minTailDistanceM: number;
  minTailMovingS: number;
}

export const DEFAULT_DETECTION_PARAMS: DetectionParams = {
  homeRadiusM: 100,
  awayRadiusM: 50,
  slowSpeedMps: 1.0,
  speedWindowS: 15,
  minTailS: 60,
  maxTailSpeedMps: 0.8,
  minTailDistanceM: 10,
  minTailMovingS: 10,
};

/**
 * Per-activity tuning. Only the "stopped" speed differs. On a bike anything
 * under ~9 km/h isn't riding, so walking the bike into the yard belongs to
 * the tail (the 2026-09-29 ride-2 case). A run keeps the cautious 1 m/s: the
 * athlete's slowest GPS runs average ~2.04 m/s (backtest 2026-09-30), so a
 * walking-pace threshold would start eating into slow jogging.
 */
export const DETECTION_PARAMS_BY_KIND: Record<'run' | 'ride', DetectionParams> =
  {
    run: DEFAULT_DETECTION_PARAMS,
    ride: { ...DEFAULT_DETECTION_PARAMS, slowSpeedMps: 2.5 },
  };

export interface MissedStopSuggestion {
  confidence: 'home' | 'away';
  /** Keep samples with time_s ≤ cutAtS. */
  cutAtS: number;
  /** max(time_s) − cutAtS: the MZY-253 late-stop trim, in seconds. */
  trimS: number;
  /** Distance the tail covers (km). */
  distanceKm: number;
  /** Moving-flagged seconds in the tail (every second when unflagged). */
  movingS: number;
}

const EARTH_R = 6_371_000;

/** Great-circle distance (m). */
export function haversineM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function point(s: DetectionStream, i: number): LatLng | null {
  const lat = s.lat[i];
  const lng = s.lng[i];
  return lat == null || lng == null ? null : { lat, lng };
}

/** Cumulative along-track distance: the stream's own, else summed GPS steps. */
function cumulativeM(s: DetectionStream): number[] {
  const n = s.timeS.length;
  const out = new Array<number>(n).fill(0);
  const own = s.distanceM;
  let prev: LatLng | null = point(s, 0);
  for (let i = 1; i < n; i++) {
    const d = own?.[i];
    const d0 = own?.[i - 1];
    if (d != null && d0 != null) {
      out[i] = out[i - 1]! + Math.max(0, d - d0);
    } else {
      const p = point(s, i);
      out[i] = out[i - 1]! + (p && prev ? haversineM(prev, p) : 0);
    }
    prev = point(s, i) ?? prev;
  }
  return out;
}

/** Index of the earliest sample of the trailing run that stays within r of anchor. */
function zoneStart(
  s: DetectionStream,
  anchor: LatLng,
  r: number,
): number | null {
  let i = s.timeS.length - 1;
  let start: number | null = null;
  for (; i >= 0; i--) {
    const p = point(s, i);
    if (!p) continue; // a GPS dropout doesn't break the zone
    if (haversineM(p, anchor) > r) break;
    start = i;
  }
  return start;
}

function detectAt(
  s: DetectionStream,
  cum: number[],
  anchor: LatLng,
  radiusM: number,
  p: DetectionParams,
): Omit<MissedStopSuggestion, 'confidence'> | null {
  const n = s.timeS.length;
  const z = zoneStart(s, anchor, radiusM);
  if (z == null) return null;
  const t = s.timeS;

  // Arrival: the last sample in the zone whose rolling speed (over the
  // window ending there) was still above walking-stopped pace. Cut after it.
  let cut = z;
  let lo = z;
  for (let i = z; i < n; i++) {
    while (lo < i && t[i]! - t[lo]! > p.speedWindowS) lo++;
    const dt = t[i]! - t[lo]!;
    if (dt > 0 && (cum[i]! - cum[lo]!) / dt > p.slowSpeedMps) cut = i;
  }
  const tailS = t[n - 1]! - t[cut]!;
  if (tailS < p.minTailS) return null;
  const tailM = cum[n - 1]! - cum[cut]!;
  if (tailM / tailS > p.maxTailSpeedMps) return null;

  let movingS = 0;
  for (let i = cut + 1; i < n; i++) {
    if (s.moving == null || s.moving[i] === true) movingS += t[i]! - t[i - 1]!;
  }
  if (tailM < p.minTailDistanceM && movingS < p.minTailMovingS) return null;
  return {
    cutAtS: t[cut]!,
    trimS: tailS,
    distanceKm: Math.round(tailM) / 1000,
    movingS,
  };
}

/**
 * A suggested late-stop trim for this stream, or null. Confidence is where
 * the recording ENDS: within the home radius → 'home', else 'away'. The zone
 * is anchored on home first, then on the final position (a tighter zone that
 * can still catch a short tail the wider home zone's arrival cut misses).
 * Streams without GPS can't be judged.
 */
export function detectMissedStop(
  s: DetectionStream,
  home: LatLng | null,
  params: DetectionParams = DEFAULT_DETECTION_PARAMS,
): MissedStopSuggestion | null {
  const n = s.timeS.length;
  if (n < 3 || s.lat.length !== n || s.lng.length !== n) return null;
  let last: LatLng | null = null;
  for (let i = n - 1; i >= 0 && !last; i--) last = point(s, i);
  if (!last) return null;
  const cum = cumulativeM(s);

  const atHome = home != null && haversineM(last, home) <= params.homeRadiusM;
  const hit =
    (atHome ? detectAt(s, cum, home, params.homeRadiusM, params) : null) ??
    detectAt(s, cum, last, params.awayRadiusM, params);
  return hit && { ...hit, confidence: atHome ? 'home' : 'away' };
}

/** An open suggestion as the run/ride detail pages show it. */
export interface StopSuggestionView {
  id: string;
  shortId: number;
  confidence: MissedStopSuggestion['confidence'];
  trimS: number;
  distanceKm: number;
  movingS: number;
}

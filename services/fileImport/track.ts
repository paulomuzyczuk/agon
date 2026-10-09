import type { RunStreamData } from '../runStreams';
import { haversineMeters } from './geo';

// Format-neutral track model + the shared math that turns a parsed track into
// the run_streams series and the run's summary metrics. The GPX and TCX parsers
// each produce a `ParsedActivity`; everything downstream (alignment, summary,
// RunRecord) works off this one shape, so a future FIT parser only has to emit a
// ParsedActivity too.
//
// This generalizes services/googleHealth/streams.ts (which parses Google's TCX
// export straight to run_streams): here we retain absolute timestamps and the
// lat/lng arrays so an export with no declared distance can be measured from its
// GPS track, and so a run's local date/start instant come from the file itself.

/** One sample from a track. Every field is null when the file omitted it. */
export interface TrackPoint {
  /** Absolute instant of the sample (epoch ms), or null if untimed. */
  timeMs: number | null;
  lat: number | null;
  lng: number | null;
  altitudeM: number | null;
  heartrate: number | null;
  cadence: number | null;
  speedMps: number | null;
  /** Cumulative distance from the file (TCX DistanceMeters), when present. */
  distanceM: number | null;
  /**
   * Power (W) from a TCX <Watts> extension — a sensor reading. Parsed for the
   * ride path (MZY-268 routes files to rides); the run import ignores it.
   */
  watts?: number | null;
}

/** File-declared summary fields (fallbacks; the track is preferred when it can answer). */
export interface DeclaredSummary {
  startTimeMs: number | null;
  totalTimeS: number | null;
  distanceM: number | null;
}

export interface ParsedActivity {
  points: TrackPoint[];
  declared: DeclaredSummary;
  /** Producer string (GPX creator= / TCX Author), for source inference. */
  creator: string | null;
}

/** The resolved metrics a run row needs, derived from track + declared summary. */
export interface ActivityMetrics {
  startTimeMs: number;
  durationS: number;
  distanceM: number;
  avgHr: number | null;
  maxHr: number | null;
  elevationGainM: number | null;
}

/** Altitude noise floor (m): only climbs above this per step count toward gain. */
const ELEV_STEP_THRESHOLD_M = 1;

function present(a: Array<number | null>): boolean {
  return a.some((v) => v !== null);
}

/**
 * Build the index-aligned run_streams series from timed trackpoints, plus the
 * route's first coordinate for runs.start_lat/lng. Mirrors the googleHealth TCX
 * parser: `timeS` (rebased to seconds-from-start) is the alignment axis, and an
 * optional array is emitted only when at least one sample carried that field, so
 * downstream code can tell "not measured" from "measured all-null". run_streams
 * stores no lat/lng, so the start point is returned separately. Returns null
 * streams when no point has a timestamp.
 */
export function alignPointsToStreams(points: TrackPoint[]): {
  streams: RunStreamData | null;
  startLat: number | null;
  startLng: number | null;
} {
  const timed = points.filter((p) => p.timeMs !== null);
  if (timed.length === 0) {
    return { streams: null, startLat: null, startLng: null };
  }

  const t0 = timed[0]!.timeMs!;
  const timeS = timed.map((p) => Math.round((p.timeMs! - t0) / 1000));
  const heartrate = timed.map((p) => p.heartrate);
  // Prefer the file's own cumulative distance (TCX DistanceMeters); GPX has no
  // such per-point field, only lat/lng, so fall back to a running haversine sum
  // over the track — the per-sample analog of trackDistanceMeters() below,
  // which already does this for the run's single summary total. Without this,
  // a GPX-only import (no declared distance) never gets a distance_m stream at
  // all, which silently excludes it from the best-effort/PR sliding-window
  // search (lib/bestEfforts.ts) even though its GPS track is perfectly usable.
  const declaredDistanceM = timed.map((p) => p.distanceM);
  const distanceM = present(declaredDistanceM)
    ? declaredDistanceM
    : cumulativeHaversineDistances(timed);
  const altitudeM = timed.map((p) => p.altitudeM);
  const cadence = timed.map((p) => p.cadence);
  const velocitySmoothMps = timed.map((p) => p.speedMps);

  const firstLatIdx = timed.findIndex((p) => p.lat !== null && p.lng !== null);
  const startLat = firstLatIdx >= 0 ? timed[firstLatIdx]!.lat : null;
  const startLng = firstLatIdx >= 0 ? timed[firstLatIdx]!.lng : null;

  const streams: RunStreamData = {
    timeS,
    heartrate: present(heartrate) ? heartrate : null,
    distanceM: present(distanceM) ? distanceM : null,
    altitudeM: present(altitudeM) ? altitudeM : null,
    cadence: present(cadence) ? cadence : null,
    velocitySmoothMps: present(velocitySmoothMps) ? velocitySmoothMps : null,
    moving: null,
  };

  return { streams, startLat, startLng };
}

/**
 * Per-sample cumulative distance (m), index-aligned with `points`, via
 * haversine between consecutive GPS fixes — the stream-level counterpart to
 * trackDistanceMeters()'s single run-level total. A point with no lat/lng
 * repeats the last known cumulative value (never null once any fix has been
 * seen) so the array stays a valid, non-decreasing distance axis for
 * lib/bestEfforts.ts's sliding-window search.
 */
function cumulativeHaversineDistances(
  points: TrackPoint[],
): Array<number | null> {
  const out: Array<number | null> = [];
  let total = 0;
  let last: TrackPoint | null = null;
  for (const p of points) {
    if (p.lat === null || p.lng === null) {
      out.push(last ? total : null);
      continue;
    }
    if (last) total += haversineMeters(last.lat!, last.lng!, p.lat, p.lng);
    last = p;
    out.push(total);
  }
  return out;
}

/** Total distance (m) walked along the GPS track, via haversine between fixes. */
function trackDistanceMeters(points: TrackPoint[]): number | null {
  let total = 0;
  let last: TrackPoint | null = null;
  for (const p of points) {
    if (p.lat === null || p.lng === null) continue;
    if (last) total += haversineMeters(last.lat!, last.lng!, p.lat, p.lng);
    last = p;
  }
  return last ? total : null;
}

/** Cumulative altitude gain (m), summing only climbs above the noise floor. */
function elevationGainMeters(points: TrackPoint[]): number | null {
  let gain = 0;
  let last: number | null = null;
  let seen = false;
  for (const p of points) {
    if (p.altitudeM === null) continue;
    seen = true;
    if (last !== null) {
      const d = p.altitudeM - last;
      if (d > ELEV_STEP_THRESHOLD_M) gain += d;
    }
    last = p.altitudeM;
  }
  return seen ? Math.round(gain * 10) / 10 : null;
}

/**
 * Resolve the run's summary metrics, preferring the track (self-consistent) and
 * falling back to the file's declared summary only where the track can't answer.
 * Returns null when the file yields neither a positive distance nor a positive
 * duration — the `runs` CHECK constraints require both, so such a file can't be
 * imported (caller raises a clear error).
 */
export function resolveMetrics(parsed: ParsedActivity): ActivityMetrics | null {
  const { points, declared } = parsed;
  const timed = points.filter((p) => p.timeMs !== null);

  const startTimeMs =
    timed.length > 0 ? timed[0]!.timeMs! : declared.startTimeMs;
  if (startTimeMs === null) return null;

  let durationS: number | null = null;
  if (timed.length >= 2) {
    const span = (timed[timed.length - 1]!.timeMs! - timed[0]!.timeMs!) / 1000;
    if (span > 0) durationS = Math.round(span);
  }
  if (durationS === null && declared.totalTimeS && declared.totalTimeS > 0) {
    durationS = Math.round(declared.totalTimeS);
  }

  // Distance: prefer the file's cumulative distance (last non-null), else measure
  // the GPS track, else the declared summary.
  let distanceM: number | null = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]!.distanceM !== null) {
      distanceM = points[i]!.distanceM;
      break;
    }
  }
  if (distanceM === null) distanceM = trackDistanceMeters(points);
  if (distanceM === null && declared.distanceM && declared.distanceM > 0) {
    distanceM = declared.distanceM;
  }

  if (distanceM === null || distanceM <= 0) return null;
  if (durationS === null || durationS <= 0) return null;

  const hrs = points
    .map((p) => p.heartrate)
    .filter((v): v is number => v !== null);
  const avgHr =
    hrs.length > 0
      ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length)
      : null;
  const maxHr = hrs.length > 0 ? Math.max(...hrs) : null;

  return {
    startTimeMs,
    durationS,
    distanceM,
    avgHr,
    maxHr,
    elevationGainM: elevationGainMeters(points),
  };
}

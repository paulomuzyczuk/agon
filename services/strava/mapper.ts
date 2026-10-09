import {
  DATA_SOURCES,
  STRAVA_RUN_TYPES,
  STRAVA_RIDE_TYPES,
} from '../../lib/constants';
import { computeBlockWeek } from '../../lib/training/trainingBlocks';
import {
  NO_RIDE_POWER,
  type RunRecord,
  type RideRecord,
  type RidePowerFields,
} from '../../lib/types';
import type { StravaSummaryActivity } from './types';

// Pure mapping from a Strava summary activity to a `runs` row. No I/O — gear
// name resolution (one network call) is done by the ingest orchestrator and
// passed in, keeping this fully unit-testable.

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Recording devices whose activities are never ingested, unless overridden
 * with STRAVA_IGNORED_DEVICES (comma-separated; empty = ignore none). The
 * Garmin Speed Sensor uploads GPS-less wheel-sensor recordings with no
 * auto-pause (moving time = elapsed time), and the athlete doesn't want them.
 */
const DEFAULT_IGNORED_DEVICES = ['Garmin Speed Sensor'];

function ignoredDevices(): string[] {
  const raw = process.env.STRAVA_IGNORED_DEVICES;
  if (raw === undefined) return DEFAULT_IGNORED_DEVICES;
  return raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
}

/** True if the activity was recorded by an ignored device (see above). */
export function isFromIgnoredDevice(
  a: StravaSummaryActivity,
  ignored: string[] = ignoredDevices(),
): boolean {
  const device = a.device_name?.trim().toLowerCase();
  return !!device && ignored.some((d) => d.toLowerCase() === device);
}

/** True if Strava classifies the activity as a run we track. */
export function isRunActivity(a: StravaSummaryActivity): boolean {
  const kind = a.sport_type ?? a.type;
  return kind !== undefined && STRAVA_RUN_TYPES.has(kind);
}

/**
 * True if the activity is a run AND has the positive distance + duration the
 * `runs` CHECK constraints require, and wasn't recorded by an ignored device.
 * Filters out e.g. a run started and immediately stopped with zero distance.
 */
export function isIngestableRun(a: StravaSummaryActivity): boolean {
  return (
    isRunActivity(a) &&
    a.distance > 0 &&
    a.moving_time > 0 &&
    !isFromIgnoredDevice(a)
  );
}

export interface MapOptions {
  /** Resolved gear display name (shoe), if the activity had a gear_id. */
  shoeName?: string | null;
}

/**
 * Maps a summary activity to a RunRecord. Assumes `isIngestableRun(a)` — callers
 * filter first. Qualitative fields (perceived_effort, pain, notes, fueling) and
 * weather are left null; they arrive via the voice-note and enrichment
 * pipelines in later milestones.
 */
export function mapActivityToRun(
  a: StravaSummaryActivity,
  { shoeName = null }: MapOptions = {},
): RunRecord {
  const date = a.start_date_local.slice(0, 10); // YYYY-MM-DD, athlete-local
  const distanceKm = round(a.distance / 1000, 3);
  const { block, week } = computeBlockWeek(date);
  const latlng = a.start_latlng;
  const hasGps = Array.isArray(latlng) && latlng.length === 2;

  return {
    date,
    // start_date is the UTC instant; keep it as the canonical start time.
    started_at: new Date(a.start_date).toISOString(),
    start_lat: hasGps ? (latlng[0] ?? null) : null,
    start_lng: hasGps ? (latlng[1] ?? null) : null,
    block,
    week,
    distance_km: distanceKm,
    duration_s: a.moving_time,
    avg_hr:
      a.average_heartrate != null ? Math.round(a.average_heartrate) : null,
    max_hr: a.max_heartrate != null ? Math.round(a.max_heartrate) : null,
    avg_pace_s_per_km:
      distanceKm > 0 ? round(a.moving_time / distanceKm, 2) : null,
    elevation_gain_m:
      a.total_elevation_gain != null ? round(a.total_elevation_gain, 1) : null,
    shoe_used: shoeName,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: a.id,
    // (source, external_id) is the idempotency key; for Strava the external id is
    // the activity id as text. strava_activity_id is kept until it's contracted.
    external_id: String(a.id),
    source: DATA_SOURCES.STRAVA,
    origin: null, // Strava doesn't distinguish an upstream platform

    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

/** True if Strava classifies the activity as a bike ride we track. */
export function isRideActivity(a: StravaSummaryActivity): boolean {
  const kind = a.sport_type ?? a.type;
  return kind !== undefined && STRAVA_RIDE_TYPES.has(kind);
}

/**
 * True if the activity is a ride AND has the positive distance + duration the
 * `rides` CHECK constraints require, and wasn't recorded by an ignored device.
 * Mirrors isIngestableRun.
 */
export function isIngestableRide(a: StravaSummaryActivity): boolean {
  return (
    isRideActivity(a) &&
    a.distance > 0 &&
    a.moving_time > 0 &&
    !isFromIgnoredDevice(a)
  );
}

/**
 * The ride's power columns from a Strava summary. Provenance comes from
 * `device_watts`: true → 'device' (a power meter measured it); absent/false
 * with watts present → 'estimated' (Strava's own model — what every ride gets
 * without a meter). No watts and no kJ → all null. A 0 average with no kJ is
 * treated as "no power" (Strava's placeholder on GPS-less/indoor rides).
 */
export function powerFields(a: StravaSummaryActivity): RidePowerFields {
  const avg = a.average_watts != null ? Math.round(a.average_watts) : null;
  const kj = a.kilojoules != null ? round(a.kilojoules, 1) : null;
  if ((avg == null || avg === 0) && kj == null) return { ...NO_RIDE_POWER };
  return {
    avg_power_w: avg,
    max_power_w: a.max_watts != null ? Math.round(a.max_watts) : null,
    weighted_avg_power_w:
      a.weighted_average_watts != null
        ? Math.round(a.weighted_average_watts)
        : null,
    kilojoules: kj,
    power_source: a.device_watts === true ? 'device' : 'estimated',
  };
}

export interface RideMapOptions {
  /** Resolved gear display name (bike), if the activity had a gear_id. */
  bikeName?: string | null;
}

/**
 * Maps a summary activity to a RideRecord. Assumes `isIngestableRide(a)` —
 * callers filter first. Speed instead of pace: `average_speed`/`max_speed`
 * (m/s) convert to km/h; when Strava omits them (older activities), average
 * speed derives from distance/moving_time same as pace does for runs.
 */
export function mapActivityToRide(
  a: StravaSummaryActivity,
  { bikeName = null }: RideMapOptions = {},
): RideRecord {
  const date = a.start_date_local.slice(0, 10); // YYYY-MM-DD, athlete-local
  const distanceKm = round(a.distance / 1000, 3);
  const { block, week } = computeBlockWeek(date);
  const latlng = a.start_latlng;
  const hasGps = Array.isArray(latlng) && latlng.length === 2;
  const mpsToKmh = (mps: number): number => round(mps * 3.6, 2);
  const avgSpeedKmh =
    a.average_speed != null
      ? mpsToKmh(a.average_speed)
      : distanceKm > 0
        ? round((distanceKm / a.moving_time) * 3600, 2)
        : null;

  return {
    date,
    started_at: new Date(a.start_date).toISOString(),
    start_lat: hasGps ? (latlng[0] ?? null) : null,
    start_lng: hasGps ? (latlng[1] ?? null) : null,
    block,
    week,
    distance_km: distanceKm,
    duration_s: a.moving_time,
    avg_hr:
      a.average_heartrate != null ? Math.round(a.average_heartrate) : null,
    max_hr: a.max_heartrate != null ? Math.round(a.max_heartrate) : null,
    avg_speed_kmh: avgSpeedKmh,
    max_speed_kmh: a.max_speed != null ? mpsToKmh(a.max_speed) : null,
    elevation_gain_m:
      a.total_elevation_gain != null ? round(a.total_elevation_gain, 1) : null,
    bike_used: bikeName,
    ...powerFields(a),
    perceived_effort: null,
    general_notes: null,
    external_id: String(a.id),
    source: DATA_SOURCES.STRAVA,
    origin: null,

    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

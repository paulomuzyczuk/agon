import { DATA_SOURCES } from '../../lib/constants';
import { computeBlockWeek } from '../../lib/training/trainingBlocks';
import {
  NO_RIDE_POWER,
  type RunRecord,
  type RideRecord,
} from '../../lib/types';
import type { ExerciseDataPoint } from './types';

// Pure mapping from a Google Health exercise data point to a `runs` row. No I/O —
// the route/GPS start point (which lives in the TCX, not the session summary) is
// resolved by the ingest orchestrator and passed in, keeping this fully
// unit-testable. Mirrors services/strava/mapper.ts.

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Parse a protobuf Duration string ("1500s", "3.5s") to seconds. Returns null for
 * an absent/malformed value.
 */
export function parseDurationSeconds(d: string | undefined): number | null {
  if (!d) return null;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(d.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** The stable external id: the trailing segment of the DataPoint resource name. */
export function dataPointExternalId(dp: ExerciseDataPoint): string | null {
  if (!dp.name) return null;
  const id = dp.name.split('/').pop();
  return id && id.length > 0 ? id : null;
}

/**
 * The upstream platform for a run (runs.origin), lowercased — e.g.
 * 'health_connect' (SOT-accurate) or 'fitbit' (auto-detected). Null when the
 * payload carries no dataSource.platform.
 */
export function dataPointOrigin(dp: ExerciseDataPoint): string | null {
  const p = dp.dataSource?.platform;
  return p ? p.toLowerCase() : null;
}

/**
 * True if Google Health classifies the session as a run we track. Matched by
 * substring so it's robust to the enum's exact spelling/prefix (RUNNING,
 * RUNNING_TREADMILL, TRAIL_RUNNING, EXERCISE_TYPE_RUNNING, …).
 * TODO(live): pin the exact enum values and tighten this to a set.
 */
export function isRunExerciseType(exerciseType: string): boolean {
  return exerciseType.toUpperCase().includes('RUNNING');
}

/**
 * True if Google Health classifies the session as a bike ride we track.
 * Matched by substring, same robustness reasoning as isRunExerciseType — the
 * test suite exercises 'CYCLING' as the documented value; 'BIKING' is
 * included as a fallback since Health Connect's own exerciseType constant is
 * named BIKING in some SDK versions.
 * TODO(live): pin the exact enum value once verified against a real payload.
 */
export function isCyclingExerciseType(exerciseType: string): boolean {
  const t = exerciseType.toUpperCase();
  return t.includes('CYCLING') || t.includes('BIKING');
}

/** Duration of a session in seconds: activeDuration if present, else end−start. */
function sessionDurationSeconds(dp: ExerciseDataPoint): number | null {
  const active = parseDurationSeconds(dp.exercise.activeDuration);
  if (active != null) return Math.round(active);
  const { startTime, endTime } = dp.exercise.interval;
  if (!endTime) return null;
  const s = Date.parse(startTime);
  const e = Date.parse(endTime);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.round((e - s) / 1000);
}

/** Distance in km from metricsSummary.distanceMillimeters, or null. */
function distanceKm(dp: ExerciseDataPoint): number | null {
  const mm = dp.exercise.metricsSummary?.distanceMillimeters;
  return mm != null && mm > 0 ? round(mm / 1_000_000, 3) : null;
}

/**
 * True if the session is a run AND has the positive distance + duration the
 * `runs` CHECK constraints require. Mirror of strava's isIngestableRun.
 */
export function isIngestableExercise(dp: ExerciseDataPoint): boolean {
  if (!isRunExerciseType(dp.exercise.exerciseType)) return false;
  if (dataPointExternalId(dp) === null) return false; // no id → can't key it
  const dist = distanceKm(dp);
  const dur = sessionDurationSeconds(dp);
  return dist != null && dist > 0 && dur != null && dur > 0;
}

/**
 * Athlete-local date (YYYY-MM-DD) from the session start. Google gives the UTC
 * instant plus a per-boundary UTC offset (Duration, e.g. "7200s"); shifting the
 * instant by the offset and reading the UTC calendar day yields the local date
 * without a hard-coded timezone. Falls back to the UTC day when no offset.
 */
export function localStartDate(
  startTime: string,
  startUtcOffset: string | undefined,
): string {
  const ms = Date.parse(startTime);
  const offsetS = parseDurationSeconds(startUtcOffset) ?? 0;
  return new Date(ms + offsetS * 1000).toISOString().slice(0, 10);
}

export interface GoogleHealthMapOptions {
  /** Route start, resolved from the TCX by the ingest orchestrator. */
  startLat?: number | null;
  startLng?: number | null;
}

/**
 * Maps an exercise data point to a RunRecord. Assumes `isIngestableExercise(dp)`
 * — callers filter first. Qualitative fields (perceived_effort, pain, notes,
 * fueling) and weather are left null; they arrive via the voice-note and
 * enrichment pipelines. start_lat/lng are null unless the caller resolved the
 * route (route-less runs stay null, so weather-per-GPS enrichment won't fire —
 * see docs/run-ingestion-migration.md §8).
 */
export function mapExerciseToRun(
  dp: ExerciseDataPoint,
  { startLat = null, startLng = null }: GoogleHealthMapOptions = {},
): RunRecord {
  const ex = dp.exercise;
  const metrics = ex.metricsSummary ?? {};
  const date = localStartDate(
    ex.interval.startTime,
    ex.interval.startUtcOffset,
  );
  const { block, week } = computeBlockWeek(date);
  const dist = distanceKm(dp)!; // guaranteed by isIngestableExercise
  const duration = sessionDurationSeconds(dp)!;
  const externalId = dataPointExternalId(dp)!;

  const avgHr = metrics.averageHeartRateBeatsPerMinute;
  const maxHr = metrics.maxHeartRateBeatsPerMinute;
  const elevMm = metrics.elevationGainMillimeters;

  return {
    date,
    started_at: new Date(ex.interval.startTime).toISOString(),
    start_lat: startLat,
    start_lng: startLng,
    block,
    week,
    distance_km: dist,
    duration_s: duration,
    avg_hr: avgHr != null ? Math.round(avgHr) : null,
    max_hr: maxHr != null ? Math.round(maxHr) : null,
    avg_pace_s_per_km: dist > 0 ? round(duration / dist, 2) : null,
    elevation_gain_m: elevMm != null ? round(elevMm / 1000, 1) : null,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: null,
    external_id: externalId,
    source: DATA_SOURCES.GOOGLE_HEALTH,
    origin: dataPointOrigin(dp),
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

/**
 * True if the session is a bike ride AND has the positive distance + duration
 * the `rides` CHECK constraints require. Mirrors isIngestableExercise.
 */
export function isIngestableCyclingExercise(dp: ExerciseDataPoint): boolean {
  if (!isCyclingExerciseType(dp.exercise.exerciseType)) return false;
  if (dataPointExternalId(dp) === null) return false;
  const dist = distanceKm(dp);
  const dur = sessionDurationSeconds(dp);
  return dist != null && dist > 0 && dur != null && dur > 0;
}

/**
 * Maps an exercise data point to a RideRecord. Assumes
 * `isIngestableCyclingExercise(dp)` — callers filter first. Speed instead of
 * pace: prefers metricsSummary.averageSpeedMillimetersPerSecond when present,
 * else derives from distance/duration (mirrors mapExerciseToRun's pace
 * fallback). start_lat/lng are null unless the caller resolved the route.
 */
export function mapExerciseToRide(
  dp: ExerciseDataPoint,
  { startLat = null, startLng = null }: GoogleHealthMapOptions = {},
): RideRecord {
  const ex = dp.exercise;
  const metrics = ex.metricsSummary ?? {};
  const date = localStartDate(
    ex.interval.startTime,
    ex.interval.startUtcOffset,
  );
  const { block, week } = computeBlockWeek(date);
  const dist = distanceKm(dp)!; // guaranteed by isIngestableCyclingExercise
  const duration = sessionDurationSeconds(dp)!;
  const externalId = dataPointExternalId(dp)!;

  const avgHr = metrics.averageHeartRateBeatsPerMinute;
  const maxHr = metrics.maxHeartRateBeatsPerMinute;
  const elevMm = metrics.elevationGainMillimeters;
  const avgSpeedMps = metrics.averageSpeedMillimetersPerSecond;

  return {
    date,
    started_at: new Date(ex.interval.startTime).toISOString(),
    start_lat: startLat,
    start_lng: startLng,
    block,
    week,
    distance_km: dist,
    duration_s: duration,
    avg_hr: avgHr != null ? Math.round(avgHr) : null,
    max_hr: maxHr != null ? Math.round(maxHr) : null,
    avg_speed_kmh:
      avgSpeedMps != null
        ? round((avgSpeedMps / 1000) * 3.6, 2)
        : dist > 0
          ? round((dist / duration) * 3600, 2)
          : null,
    max_speed_kmh: null,
    elevation_gain_m: elevMm != null ? round(elevMm / 1000, 1) : null,
    bike_used: null,
    // The session summary carries no power; a TCX <Watts> series (if a sensor
    // ever produced one) lands in ride_streams only.
    ...NO_RIDE_POWER,
    perceived_effort: null,
    general_notes: null,
    external_id: externalId,
    source: DATA_SOURCES.GOOGLE_HEALTH,
    origin: dataPointOrigin(dp),
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

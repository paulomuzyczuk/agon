import { query } from './db';
import type { SourceDevice } from '../lib/sourceDevices';

// Storage for whole-run time series (see migrations/20260723006000_run_streams.sql).
// Source-agnostic on purpose: the Strava backfill writes here today, and a Fitbit
// or Garmin importer can write the same shape under its own `source` tomorrow.

export type StreamSource =
  | 'strava'
  | 'fitbit'
  | 'garmin'
  | 'polar'
  | 'google_health'
  // File-import series (Workstream B): kept under the same tag as the run so a
  // run and its time series stay source-aligned (see runs.source).
  | 'samsung_export'
  | 'garmin_export'
  | 'strava_export'
  // Browser-side live recording (app/record) — see lib/constants.ts DATA_SOURCES.
  | 'live_recording';

/**
 * Index-aligned sample arrays for one run. `timeS` is the alignment axis and is
 * required; every other array, when present, has the same length as `timeS`.
 * Numeric arrays may contain nulls where a sensor dropped out mid-run.
 */
export interface RunStreamData {
  timeS: number[];
  heartrate?: Array<number | null> | null;
  distanceM?: Array<number | null> | null;
  altitudeM?: Array<number | null> | null;
  cadence?: Array<number | null> | null;
  velocitySmoothMps?: Array<number | null> | null;
  moving?: boolean[] | null;
  /** GPS track, index-aligned with timeS. Both present or both null. */
  lat?: Array<number | null> | null;
  lng?: Array<number | null> | null;
  /**
   * Per-point device provenance (MZY-271), live recordings only: the devices
   * that supplied this row, and per point the index of the one that produced
   * heartrate[i]. Null/absent = unknown (every import path).
   */
  sourceDevices?: SourceDevice[] | null;
  heartrateSourceDevice?: Array<number | null> | null;
}

const jsonOrNull = (v: unknown) => (v == null ? null : JSON.stringify(v));

/** Whether a stream for this run+source already exists (drives resumable backfill). */
export async function hasRunStreams(
  runId: string,
  source: StreamSource,
): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM public.run_streams WHERE run_id = $1 AND source = $2',
    [runId, source],
  );
  return rows.length > 0;
}

/** Upsert the full time series for a run+source (idempotent). */
export async function upsertRunStreams(
  runId: string,
  source: StreamSource,
  data: RunStreamData,
): Promise<void> {
  await query(
    `INSERT INTO public.run_streams
       (run_id, source, time_s, heartrate, distance_m, altitude_m, cadence,
        velocity_smooth_mps, moving, lat, lng, sample_count,
        source_devices, heartrate_source_device)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14)
     ON CONFLICT (run_id, source) DO UPDATE SET
       time_s              = EXCLUDED.time_s,
       heartrate           = EXCLUDED.heartrate,
       distance_m          = EXCLUDED.distance_m,
       altitude_m          = EXCLUDED.altitude_m,
       cadence             = EXCLUDED.cadence,
       velocity_smooth_mps = EXCLUDED.velocity_smooth_mps,
       moving              = EXCLUDED.moving,
       lat                 = EXCLUDED.lat,
       lng                 = EXCLUDED.lng,
       sample_count        = EXCLUDED.sample_count,
       source_devices      = EXCLUDED.source_devices,
       heartrate_source_device = EXCLUDED.heartrate_source_device,
       fetched_at          = now()`,
    [
      runId,
      source,
      data.timeS,
      data.heartrate ?? null,
      data.distanceM ?? null,
      data.altitudeM ?? null,
      data.cadence ?? null,
      data.velocitySmoothMps ?? null,
      data.moving ?? null,
      data.lat ?? null,
      data.lng ?? null,
      data.timeS.length,
      jsonOrNull(data.sourceDevices),
      data.heartrateSourceDevice ?? null,
    ],
  );
}

/** Update just derived_moving for an existing run+source stream (lib/movingTime.ts::deriveMovingFlags). */
export async function updateDerivedMoving(
  runId: string,
  source: StreamSource,
  derivedMoving: boolean[],
): Promise<void> {
  await query(
    `UPDATE public.run_streams
        SET derived_moving = $3
      WHERE run_id = $1 AND source = $2`,
    [runId, source, derivedMoving],
  );
}

/** Update just fitbit_cadence for an existing run+source stream (services/googleHealth/steps.ts + lib/fitbitCadence.ts). */
export async function updateFitbitCadence(
  runId: string,
  source: StreamSource,
  fitbitCadence: Array<number | null>,
): Promise<void> {
  await query(
    `UPDATE public.run_streams
        SET fitbit_cadence = $3
      WHERE run_id = $1 AND source = $2`,
    [runId, source, fitbitCadence],
  );
}

// ── Ride streams (mirrors the run functions above; see
// migrations/20260910020000_ride_streams.sql). Reuses RunStreamData/
// StreamSource — the sample shape is identical, only the table differs —
// plus a power series (migrations/20261004000000_ride_power.sql). ──────────

/** Provenance of a ride stream's watts: a power meter, or a source's model. */
export type WattsSource = 'device' | 'estimated';

/**
 * RunStreamData plus power. `watts` is index-aligned with timeS like every
 * other series; `wattsSource` is required whenever `watts` is present — only
 * 'device' watts may ever feed NP/TSS/curves.
 */
export interface RideStreamData extends RunStreamData {
  watts?: Array<number | null> | null;
  wattsSource?: WattsSource | null;
  /** Per-point device indices into sourceDevices (MZY-271), live recordings only. */
  cadenceSourceDevice?: Array<number | null> | null;
  velocitySourceDevice?: Array<number | null> | null;
  wattsSourceDevice?: Array<number | null> | null;
}

/** Whether a stream for this ride+source already exists (drives resumable backfill). */
export async function hasRideStreams(
  rideId: string,
  source: StreamSource,
): Promise<boolean> {
  const { rows } = await query(
    'SELECT 1 FROM public.ride_streams WHERE ride_id = $1 AND source = $2',
    [rideId, source],
  );
  return rows.length > 0;
}

/** Upsert the full time series for a ride+source (idempotent). */
export async function upsertRideStreams(
  rideId: string,
  source: StreamSource,
  data: RideStreamData,
): Promise<void> {
  const watts = data.watts ?? null;
  if (watts && !data.wattsSource) {
    // Unlabelled watts would be indistinguishable from measured ones.
    throw new Error(
      `upsertRideStreams: ride ${rideId} (${source}) has watts but no wattsSource`,
    );
  }
  await query(
    `INSERT INTO public.ride_streams
       (ride_id, source, time_s, heartrate, distance_m, altitude_m, cadence,
        velocity_smooth_mps, moving, lat, lng, watts, watts_source,
        sample_count, source_devices, heartrate_source_device,
        cadence_source_device, velocity_source_device, watts_source_device)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
             $15::jsonb,$16,$17,$18,$19)
     ON CONFLICT (ride_id, source) DO UPDATE SET
       time_s              = EXCLUDED.time_s,
       heartrate           = EXCLUDED.heartrate,
       distance_m          = EXCLUDED.distance_m,
       altitude_m          = EXCLUDED.altitude_m,
       cadence             = EXCLUDED.cadence,
       velocity_smooth_mps = EXCLUDED.velocity_smooth_mps,
       moving              = EXCLUDED.moving,
       lat                 = EXCLUDED.lat,
       lng                 = EXCLUDED.lng,
       watts               = EXCLUDED.watts,
       watts_source        = EXCLUDED.watts_source,
       sample_count        = EXCLUDED.sample_count,
       source_devices          = EXCLUDED.source_devices,
       heartrate_source_device = EXCLUDED.heartrate_source_device,
       cadence_source_device   = EXCLUDED.cadence_source_device,
       velocity_source_device  = EXCLUDED.velocity_source_device,
       watts_source_device     = EXCLUDED.watts_source_device,
       fetched_at          = now()`,
    [
      rideId,
      source,
      data.timeS,
      data.heartrate ?? null,
      data.distanceM ?? null,
      data.altitudeM ?? null,
      data.cadence ?? null,
      data.velocitySmoothMps ?? null,
      data.moving ?? null,
      data.lat ?? null,
      data.lng ?? null,
      watts,
      watts ? data.wattsSource : null,
      data.timeS.length,
      jsonOrNull(data.sourceDevices),
      data.heartrateSourceDevice ?? null,
      data.cadenceSourceDevice ?? null,
      data.velocitySourceDevice ?? null,
      watts ? (data.wattsSourceDevice ?? null) : null,
    ],
  );
}

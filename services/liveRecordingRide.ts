import { NO_RIDE_POWER, type RideRecord } from '../lib/types';
import { computeBlockWeek } from '../lib/training/trainingBlocks';
import { MERIDA_SILEX_400 } from '../lib/gear';
import { upsertRide } from './strava/rideIngest';
import { upsertRideStreams } from './runStreams';
import { resolveLocalGear, linkRideGear } from './gear';
import {
  computeHrSummary,
  computePowerSummary,
  computeSpeedSummary,
  toRideStreamData,
  type RideStreamSamples,
} from '../lib/liveRecordingStreams';
import {
  gpsDistanceM,
  resolveDistanceKm,
  wheelDistanceM,
} from '../lib/liveRecordingDistance';
import { MissingDistanceError } from './liveRecording';
import { elevationGainM } from '../lib/elevationGain';
import {
  classifyIncomingActivity,
  supersedeActivities,
} from './activitySources';
import { recomputeRidePowerMetrics } from './ridePowerMetrics';
import { getAthleteProfile } from '../lib/athleteProfile';
import { logger } from './logger';

// Flush path for a live-recorded RIDE (MZY-168), sibling to
// services/liveRecording.ts (the run path) — same 'live_recording' source tag,
// same reuse of the EXISTING source-agnostic upsertRide (services/strava/
// rideIngest.ts) and upsertRideStreams (services/runStreams.ts) unchanged. The
// only new pieces are the derivation of rides.* fields from raw HR/speed/
// cadence samples (there's no upstream activity summary to read them from) and
// linking the single current bike (lib/gear.ts MERIDA_SILEX_400) — every
// live-recorded ride is done on it, by the single-current-bike assumption
// documented there.
//
// Distance (MZY-282): a typed distanceKm wins; else the Android app's GPS
// track; else the speed sensor's wheel-revolution odometer × the bike's wheel
// circumference (lib/liveRecordingDistance.ts). The GPS track also gives
// start_lat/start_lng and the route series in ride_streams.
//
// Power (MZY-270): a BLE Cycling Power meter's samples are DEVICE-measured, so
// the ride's summary power gets power_source='device' and its watts series
// watts_source='device' — the provenance that lets NP/IF/TSS and the power
// curve (services/ridePowerMetrics.ts) be computed right after the flush.

export interface FinishLiveRecordingRideInput {
  recordingId: string; // client-generated UUID — doubles as external_id
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  samples: RideStreamSamples & {
    speed: Array<{ tMs: number; speedKmh: number; wheelRevs?: number }>;
  };
  /** Athlete-typed override; derived from GPS, else the wheel, when absent. */
  distanceKm?: number;
}

export interface FinishLiveRecordingRideResult {
  rideId: string;
  status: 'inserted' | 'updated';
  sampleCount: number;
  distanceSource: 'manual' | 'gps' | 'wheel';
}

export async function finishLiveRecordingRide(
  input: FinishLiveRecordingRideInput,
): Promise<FinishLiveRecordingRideResult> {
  const durationS = Math.max(
    1,
    Math.round((input.endedAt - input.startedAt) / 1000),
  );
  const gps = [...(input.samples.gps ?? [])].sort((a, b) => a.tMs - b.tMs);
  const circumferenceMm = MERIDA_SILEX_400.wheelCircumferenceMm;
  const distance = resolveDistanceKm({
    manualKm: input.distanceKm,
    gpsM: gpsDistanceM(gps),
    wheelM:
      circumferenceMm != null
        ? wheelDistanceM(input.samples.speed, circumferenceMm)
        : undefined,
  });
  if (!distance) throw new MissingDistanceError();
  const { avgHr, maxHr } = computeHrSummary(input.samples.hr);
  // No speed sensor: the GPS fixes' own speeds stand in (m/s → km/h).
  const { avgSpeedKmh, maxSpeedKmh } = computeSpeedSummary(
    input.samples.speed.length > 0
      ? input.samples.speed
      : gps.flatMap((s) =>
          s.speedMps == null ? [] : [{ speedKmh: s.speedMps * 3.6 }],
        ),
  );
  const power = computePowerSummary(input.samples.power ?? []);
  const startedAtIso = new Date(input.startedAt).toISOString();
  const dateISO = startedAtIso.slice(0, 10);
  const { block, week } = computeBlockWeek(dateISO);

  const streamData = toRideStreamData(
    { ...input.samples, gps },
    input.startedAt,
  );

  const ride: RideRecord = {
    date: dateISO,
    started_at: startedAtIso,
    start_lat: gps[0]?.lat ?? null,
    start_lng: gps[0]?.lng ?? null,
    block,
    week,
    distance_km: distance.km,
    duration_s: durationS,
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_speed_kmh: avgSpeedKmh,
    max_speed_kmh: maxSpeedKmh,
    // Smoothed GPS altitude (MZY-295); null without a usable track.
    elevation_gain_m: elevationGainM(
      streamData.distanceM ?? [],
      streamData.altitudeM ?? [],
    ),
    bike_used: MERIDA_SILEX_400.name,
    // A power meter measured these (MZY-270); weighted_avg_power_w stays null —
    // it is reserved for a SOURCE's own NP-like figure, Agon's NP lives in
    // ride_power_metrics.
    ...(power.avgPowerW == null
      ? NO_RIDE_POWER
      : {
          avg_power_w: power.avgPowerW,
          max_power_w: power.maxPowerW,
          weighted_avg_power_w: null,
          kilojoules: power.kilojoules,
          power_source: 'device' as const,
        }),
    perceived_effort: null,
    general_notes: null,
    external_id: input.recordingId,
    source: 'live_recording',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };

  const { id: rideId, status } = await upsertRide(ride);

  // Agon's own recording is top priority (MZY-225): a Strava/export/Google
  // Health twin of this ride that's already stored is merged into it and removed.
  const { supersede } = await classifyIncomingActivity('ride', ride);
  await supersedeActivities('ride', rideId, supersede);

  // Resolve the bike BY NAME: Strava's gear sync may already hold it under its
  // own id (b…), and gear names are unique case-insensitively
  // (idx_gear_name_ci), so minting a second 'local:' row would fail the flush.
  const bikeGearId = await resolveLocalGear(
    MERIDA_SILEX_400.name,
    MERIDA_SILEX_400.category,
  );
  await linkRideGear(rideId, bikeGearId);

  if (streamData.timeS.length > 0) {
    await upsertRideStreams(rideId, 'live_recording', streamData);
  }
  if (streamData.watts) {
    // Best-effort, like the route's weather/missed-stop passes: the ride is
    // saved; `pnpm power:backfill-metrics` repairs a failed recompute.
    try {
      await recomputeRidePowerMetrics(rideId, getAthleteProfile().ftpHistory);
    } catch (err) {
      logger.warn('power metrics after live ride flush failed', {
        job: 'live-recording-ride',
        rideId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const sampleCount =
    input.samples.hr.length +
    input.samples.speed.length +
    input.samples.cadence.length +
    (input.samples.power?.length ?? 0) +
    gps.length;

  return { rideId, status, sampleCount, distanceSource: distance.source };
}

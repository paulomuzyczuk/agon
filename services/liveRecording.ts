import type { RunRecord } from '../lib/types';
import { computeBlockWeek } from '../lib/training/trainingBlocks';
import { upsertRun } from './strava/ingest';
import { upsertRunStreams } from './runStreams';
import {
  computeHrSummary,
  toRunStreamData,
  type GpsStreamSample,
} from '../lib/liveRecordingStreams';
import { gpsDistanceM, resolveDistanceKm } from '../lib/liveRecordingDistance';
import { elevationGainM } from '../lib/elevationGain';
import type { SampleDevice } from '../lib/sourceDevices';
import {
  classifyIncomingActivity,
  supersedeActivities,
} from './activitySources';

// Flush path for app/record (CLAUDE.md "Live Run Recording"): turns a finished
// browser-side recording (buffered to IndexedDB, see lib/liveRecordingDb.ts) into
// a runs + run_streams row. Reuses the EXISTING source-agnostic upsertRun
// (services/strava/ingest.ts) and upsertRunStreams (services/runStreams.ts)
// unchanged — the only new piece is the 'live_recording' source tag
// (migrations/20260908000000_run_live_recording_source.sql) and the derivation
// of runs.* fields from raw HR samples, since a live recording has no upstream
// activity summary to read them from.
//
// The runs row is created HERE, on a successful flush, never when the recording
// starts: distance_km is NOT NULL CHECK > 0 (see services/runs.ts
// insertManualRun) and isn't known before the end. Since MZY-282 it comes from
// the Android app's GPS track unless the athlete typed one
// (lib/liveRecordingDistance.ts); the track also gives start_lat/start_lng
// and the route/distance series in run_streams.

/** One HR sample, stamped with the strap that produced it (MZY-271) when known. */
export interface HrSampleInput extends SampleDevice {
  tMs: number; // absolute epoch ms
  bpm: number;
  sensorContact: string;
}

export interface FinishLiveRecordingInput {
  recordingId: string; // client-generated UUID — doubles as external_id
  startedAt: number; // epoch ms
  endedAt: number; // epoch ms
  deviceName: string;
  samples: HrSampleInput[];
  /** Phone-GPS fixes, accepted at write time (MZY-281); empty without GPS. */
  gps?: GpsStreamSample[];
  /** Athlete-typed override; derived from the GPS track when absent. */
  distanceKm?: number;
}

export interface FinishLiveRecordingResult {
  runId: string;
  status: 'inserted' | 'updated';
  sampleCount: number;
  distanceSource: 'manual' | 'gps' | 'wheel';
}

/** No typed distance and nothing to derive one from — the client asks for one. */
export class MissingDistanceError extends Error {
  constructor() {
    super('No distance: no GPS track to measure — enter the distance (km).');
    this.name = 'MissingDistanceError';
  }
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export async function finishLiveRecording(
  input: FinishLiveRecordingInput,
): Promise<FinishLiveRecordingResult> {
  const durationS = Math.max(
    1,
    Math.round((input.endedAt - input.startedAt) / 1000),
  );
  const gps = [...(input.gps ?? [])].sort((a, b) => a.tMs - b.tMs);
  const distance = resolveDistanceKm({
    manualKm: input.distanceKm,
    gpsM: gpsDistanceM(gps),
  });
  if (!distance) throw new MissingDistanceError();
  const distanceKm = distance.km;
  const { avgHr, maxHr } = computeHrSummary(input.samples);
  const startedAtIso = new Date(input.startedAt).toISOString();
  const dateISO = startedAtIso.slice(0, 10);
  const { block, week } = computeBlockWeek(dateISO);
  const sorted = [...input.samples].sort((a, b) => a.tMs - b.tMs);
  // Carries per-point device provenance when the samples are stamped.
  const streamData = toRunStreamData(sorted, input.startedAt, gps);

  const run: RunRecord = {
    date: dateISO,
    started_at: startedAtIso,
    start_lat: gps[0]?.lat ?? null,
    start_lng: gps[0]?.lng ?? null,
    block,
    week,
    distance_km: distanceKm,
    duration_s: durationS,
    avg_hr: avgHr,
    max_hr: maxHr,
    avg_pace_s_per_km: distanceKm > 0 ? round(durationS / distanceKm, 2) : null,
    // Smoothed GPS altitude (MZY-295); null without a usable track.
    elevation_gain_m: elevationGainM(
      streamData.distanceM ?? [],
      streamData.altitudeM ?? [],
    ),
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: null,
    external_id: input.recordingId,
    source: 'live_recording',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };

  const { id: runId, status } = await upsertRun(run);

  // Agon's own recording is top priority (MZY-225): a Strava/export/Google
  // Health twin of this run that's already stored is merged into it and removed.
  const { supersede } = await classifyIncomingActivity('run', run);
  await supersedeActivities('run', runId, supersede);

  await upsertRunStreams(runId, 'live_recording', streamData);

  return {
    runId,
    status,
    sampleCount: sorted.length + gps.length,
    distanceSource: distance.source,
  };
}

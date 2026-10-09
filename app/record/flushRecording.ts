import {
  getCadenceSamples,
  getGpsSamples,
  getHrSamples,
  getPowerSamples,
  getSpeedSamples,
  markFlushed,
  replayJournals,
  stopRecording,
  type ActivityType,
  type RecordingHeader,
} from '@/lib/liveRecordingDb';
import {
  gpsDistanceM,
  resolveDistanceKm,
  wheelDistanceM,
  type ResolvedDistance,
} from '@/lib/liveRecordingDistance';
import { MERIDA_SILEX_400 } from '@/lib/gear';
import type { SampleDevice } from '@/lib/sourceDevices';

// The Save half of app/record's "unfinished recordings" list, split out of
// UnflushedRecordings.tsx: read a recording's buffered samples back out of
// IndexedDB and POST them to the run or ride finish endpoint, then mark it
// flushed. Since MZY-282 the body carries the GPS track (and, for a ride,
// the wheel-revolution counter), and the distance is an optional override —
// `previewDistance` shows the athlete what the server will derive.

/** Recordings written before MZY-168 have no activityType — they are runs. */
const activityOf = (h: RecordingHeader): ActivityType =>
  h.activityType ?? 'run';

/** The distance the server will derive without a typed one, or null. */
export async function previewDistance(
  header: RecordingHeader,
): Promise<ResolvedDistance | null> {
  const [gps, speed] = await Promise.all([
    getGpsSamples(header.id),
    activityOf(header) === 'ride' ? getSpeedSamples(header.id) : [],
  ]);
  const circumferenceMm = MERIDA_SILEX_400.wheelCircumferenceMm;
  return resolveDistanceKm({
    gpsM: gpsDistanceM(gps),
    wheelM:
      speed.length > 0 && circumferenceMm != null
        ? wheelDistanceM(speed, circumferenceMm)
        : undefined,
  });
}

export async function flushRecording(
  header: RecordingHeader,
  distanceKm: number | undefined,
): Promise<{ activityType: ActivityType; id: string }> {
  // Samples the native journal kept but IndexedDB lost (MZY-294).
  await replayJournals({ only: header.id });
  // A killed tab or app never got a Stop click, so the header may still say
  // 'recording' — it ended with its last sample, not now (MZY-294: else the
  // time until the app was reopened would count as duration).
  const finalized =
    header.status === 'recording'
      ? await stopRecording(header.id, await lastSampleMs(header))
      : header;
  const activityType = activityOf(finalized);
  const gps = (await getGpsSamples(finalized.id)).map((s) => ({
    tMs: s.tMs,
    lat: s.lat,
    lng: s.lng,
    altitudeM: s.altitudeM,
    accuracyM: s.accuracyM,
    speedMps: s.speedMps,
    ...deviceOf(s),
  }));
  const base = {
    recordingId: finalized.id,
    startedAt: finalized.startedAt,
    endedAt: finalized.endedAt,
    ...(distanceKm != null ? { distanceKm } : {}),
  };

  let body: unknown;
  if (activityType === 'run') {
    const hr = await getHrSamples(finalized.id);
    body = {
      ...base,
      deviceName: finalized.deviceName,
      samples: hr.map((s) => ({
        tMs: s.tMs,
        bpm: s.bpm,
        sensorContact: s.sensorContact,
        ...deviceOf(s),
      })),
      gps,
    };
  } else {
    const [hr, speed, cadence, power] = await Promise.all([
      getHrSamples(finalized.id),
      getSpeedSamples(finalized.id),
      getCadenceSamples(finalized.id),
      getPowerSamples(finalized.id),
    ]);
    body = {
      ...base,
      samples: {
        hr: hr.map((s) => ({ tMs: s.tMs, bpm: s.bpm, ...deviceOf(s) })),
        speed: speed.map((s) => ({
          tMs: s.tMs,
          speedKmh: s.speedKmh,
          ...(s.wheelRevs != null ? { wheelRevs: s.wheelRevs } : {}),
          ...deviceOf(s),
        })),
        cadence: cadence.map((s) => ({
          tMs: s.tMs,
          rpm: s.rpm,
          ...deviceOf(s),
        })),
        power: power.map((s) => ({
          tMs: s.tMs,
          watts: s.watts,
          ...deviceOf(s),
        })),
        gps,
      },
    };
  }

  const res = await fetch(
    activityType === 'run'
      ? '/api/live-recording/finish'
      : '/api/live-recording/finish-ride',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `save failed (${res.status})`);
  }
  const saved = (await res.json()) as { runId?: string; rideId?: string };
  await markFlushed(finalized.id);
  return { activityType, id: (saved.runId ?? saved.rideId)! };
}

/** The newest buffered sample's time, or now when there is none. */
async function lastSampleMs(header: RecordingHeader): Promise<number> {
  const all = await Promise.all([
    getHrSamples(header.id),
    getSpeedSamples(header.id),
    getCadenceSamples(header.id),
    getPowerSamples(header.id),
    getGpsSamples(header.id),
  ]);
  const last = Math.max(...all.map((xs) => xs.at(-1)?.tMs ?? -Infinity));
  return Number.isFinite(last) ? Math.max(last, header.startedAt) : Date.now();
}

/** The device stamp of a buffered sample (MZY-271); empty for pre-stamp samples. */
function deviceOf(s: SampleDevice): SampleDevice {
  return s.deviceId
    ? {
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        deviceKind: s.deviceKind,
      }
    : {};
}

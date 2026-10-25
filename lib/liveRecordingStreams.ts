// Pure stream builders and summaries for the live-recording flush, split out
// of lib/liveRecordingDb.ts (MZY-281) so that file holds only the IndexedDB
// buffer. Shared by the recorder (browser) and the flush (services/,
// server); unit-tested in __tests__/lib/liveRecordingStreams.test.ts.

import { cumulativeDistancesM } from './gpsTrack';
import { resampleTo1Hz } from './power';
import {
  buildDeviceIndex,
  type SampleDevice,
  type SourceDevice,
} from './sourceDevices';

/** A buffered phone-GPS fix (MZY-281), as the finish bodies carry it. */
export interface GpsStreamSample extends SampleDevice {
  tMs: number;
  lat: number;
  lng: number;
  altitudeM: number | null;
  accuracyM: number;
  speedMps: number | null;
}

/** The route series both stream tables share (all NUMERIC[]). */
export interface GpsStreamData {
  lat?: Array<number | null>;
  lng?: Array<number | null>;
  altitudeM?: Array<number | null>;
  distanceM?: Array<number | null>;
}

export interface LiveRunStreamData extends GpsStreamData {
  timeS: number[];
  heartrate?: Array<number | null>;
  /** From the GPS fixes' own speed (MZY-282). */
  velocitySmoothMps?: Array<number | null>;
  /** Present only when the samples carry device stamps (MZY-271). */
  sourceDevices?: SourceDevice[];
  heartrateSourceDevice?: Array<number | null>;
}

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

type Slots = Map<number, { v: number; d: number | null }>;

/**
 * The shared 1 s alignment axis of a live recording's stream row: every
 * sample (any device, any metric) is bucketed to the nearest second from
 * `startedAtMs`; the axis is the union of buckets that got at least one
 * sample, and a metric is `null` in a bucket none of its samples landed in
 * (same "null means a sensor dropped out" convention as RunStreamData,
 * services/runStreams.ts). Within one second the last sample wins.
 */
function alignment(
  startedAtMs: number,
  all: ReadonlyArray<{ tMs: number } & SampleDevice>,
) {
  const bucket = (tMs: number) => Math.round((tMs - startedAtMs) / 1000);
  const { sourceDevices, indexOf } = buildDeviceIndex(all);
  return {
    bucket,
    sourceDevices,
    /** second → { value, device index } for one metric. */
    bySecond: <S extends { tMs: number } & SampleDevice>(
      list: readonly S[],
      value: (s: S) => number,
    ): Slots =>
      new Map(
        list.map((s) => [
          bucket(s.tMs),
          { v: value(s), d: indexOf(s.deviceId) },
        ]),
      ),
  };
}

const axisOf = (...keys: Iterable<number>[]) =>
  [...new Set(keys.flatMap((k) => [...k]))].sort((a, b) => a - b);

/** A metric's values on the axis — omitted (undefined) when it never reported. */
const valuesOn = (timeS: number[], m: Slots) =>
  m.size > 0 ? timeS.map((t) => m.get(t)?.v ?? null) : undefined;
const devicesOn = (timeS: number[], m: Slots) =>
  m.size > 0 ? timeS.map((t) => m.get(t)?.d ?? null) : undefined;

/**
 * lat/lng (7 dp ≈ 1 cm), altitude (1 dp) and cumulative distance (1 dp) on
 * the axis. Distance is recounted from the accepted fixes exactly as the
 * live readout counted it (lib/gpsTrack.ts) and FORWARD-FILLED after the
 * first fix — it is monotonic, and the HR-over-distance chart needs an x for
 * every HR point — but null before the first fix. No `_source_device` arrays
 * for the route: one phone GPS per recording, named in `source_devices`.
 */
function gpsStreams(
  gps: readonly GpsStreamSample[],
  timeS: number[],
  bucket: (tMs: number) => number,
): GpsStreamData {
  if (gps.length === 0) return {};
  const cum = cumulativeDistancesM(gps);
  const byT = new Map(
    gps.map((s, i) => [bucket(s.tMs), { s, distM: cum[i]! }]),
  );
  const at = <T>(f: (x: { s: GpsStreamSample; distM: number }) => T) =>
    timeS.map((t) => {
      const x = byT.get(t);
      return x ? f(x) : null;
    });
  let carried: number | null = null;
  const hasAltitude = gps.some((s) => s.altitudeM != null);
  return {
    lat: at((x) => round(x.s.lat, 7)),
    lng: at((x) => round(x.s.lng, 7)),
    ...(hasAltitude
      ? {
          altitudeM: at((x) =>
            x.s.altitudeM == null ? null : round(x.s.altitudeM, 1),
          ),
        }
      : {}),
    distanceM: timeS.map((t) => {
      const x = byT.get(t);
      if (x) carried = round(x.distM, 1);
      return carried;
    }),
  };
}

/** GPS fixes that report a speed → m/s slots (2 dp). */
const gpsSpeedSlots = (
  a: ReturnType<typeof alignment>,
  gps: readonly GpsStreamSample[],
) =>
  a.bySecond(
    gps.filter((s) => s.speedMps != null),
    (s) => round(s.speedMps!, 2),
  );

/**
 * run_streams series for a live-recorded run: HR (when a strap was
 * connected) plus, from the Android app's GPS (MZY-282), the route,
 * cumulative distance and speed — all on the shared 1 s axis (see
 * `alignment`). Assumes each list is sorted by tMs ascending (the
 * IndexedDB getters guarantee it). The field names are run_streams'
 * RunStreamData's, so the result goes straight into upsertRunStreams.
 */
export function toRunStreamData(
  hr: ReadonlyArray<{ tMs: number; bpm: number } & SampleDevice>,
  startedAtMs: number,
  gps: readonly GpsStreamSample[] = [],
): LiveRunStreamData {
  const a = alignment(startedAtMs, [...hr, ...gps]);
  const hrByT = a.bySecond(hr, (s) => s.bpm);
  const speedByT = gpsSpeedSlots(a, gps);
  const timeS = axisOf(
    hrByT.keys(),
    gps.map((s) => a.bucket(s.tMs)),
  );
  const out: LiveRunStreamData = {
    timeS,
    heartrate: valuesOn(timeS, hrByT),
    velocitySmoothMps: valuesOn(timeS, speedByT),
    ...gpsStreams(gps, timeS, a.bucket),
  };
  if (a.sourceDevices.length > 0) {
    out.sourceDevices = a.sourceDevices;
    out.heartrateSourceDevice = devicesOn(timeS, hrByT);
  }
  return out;
}

export interface HrSummary {
  avgHr: number | null;
  maxHr: number | null;
}

/** avg/max BPM across a recording's samples — null (not 0) when there's nothing to summarize. */
export function computeHrSummary(samples: Array<{ bpm: number }>): HrSummary {
  if (samples.length === 0) return { avgHr: null, maxHr: null };
  let sum = 0;
  let max = -Infinity;
  for (const s of samples) {
    sum += s.bpm;
    if (s.bpm > max) max = s.bpm;
  }
  return { avgHr: Math.round(sum / samples.length), maxHr: max };
}

export interface SpeedSummary {
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
}

/**
 * avg/max km/h across a ride's speed samples — null (not 0) when there's
 * nothing to summarize. The average is the MOVING average: stopped (0) samples
 * are left out. A stop used to leave no sample at all; now the sensors record
 * 0 for a standing bike, and excluding those keeps the saved average what it
 * was. A ride that never moved averages 0.
 */
export function computeSpeedSummary(
  samples: Array<{ speedKmh: number }>,
): SpeedSummary {
  if (samples.length === 0) return { avgSpeedKmh: null, maxSpeedKmh: null };
  let sum = 0;
  let moving = 0;
  let max = -Infinity;
  for (const s of samples) {
    if (s.speedKmh > 0) {
      sum += s.speedKmh;
      moving += 1;
    }
    if (s.speedKmh > max) max = s.speedKmh;
  }
  return {
    avgSpeedKmh: moving === 0 ? 0 : Math.round((sum / moving) * 100) / 100,
    maxSpeedKmh: Math.round(max * 100) / 100,
  };
}

export interface PowerSummary {
  avgPowerW: number | null;
  maxPowerW: number | null;
  kilojoules: number | null;
}

/**
 * avg/max W and work (kJ) across a ride's DEVICE power samples, over the
 * active timeline: resampled to 1 Hz by lib/power.ts resampleTo1Hz, so a
 * pause longer than MAX_HOLD_GAP_S is excluded and a 4 Hz meter isn't
 * over-counted — the same rules NP/TSS use. Null (not 0) with no samples.
 */
export function computePowerSummary(
  samples: Array<{ tMs: number; watts: number }>,
): PowerSummary {
  if (samples.length === 0) {
    return { avgPowerW: null, maxPowerW: null, kilojoules: null };
  }
  const t0 = samples[0]!.tMs;
  const series = resampleTo1Hz(
    samples.map((s) => (s.tMs - t0) / 1000),
    samples.map((s) => s.watts),
  );
  let sum = 0;
  let max = 0;
  for (const w of series) {
    sum += w;
    if (w > max) max = w;
  }
  return {
    avgPowerW: Math.round(sum / series.length),
    maxPowerW: Math.round(max),
    kilojoules: Math.round(sum / 100) / 10, // J → kJ, 1 decimal
  };
}

export interface RideStreamSamples {
  hr: Array<{ tMs: number; bpm: number } & SampleDevice>;
  speed: Array<{ tMs: number; speedKmh: number } & SampleDevice>;
  cadence: Array<{ tMs: number; rpm: number } & SampleDevice>;
  /** Power-meter samples (MZY-270); optional so a pre-meter caller is unchanged. */
  power?: Array<{ tMs: number; watts: number } & SampleDevice>;
  /** Phone-GPS fixes (MZY-282); optional so a pre-GPS caller is unchanged. */
  gps?: GpsStreamSample[];
}

export interface RideStreamData extends GpsStreamData {
  timeS: number[];
  heartrate?: Array<number | null>;
  cadence?: Array<number | null>;
  velocitySmoothMps?: Array<number | null>;
  /** Present only with power samples — always a power meter's, so always 'device'. */
  watts?: Array<number | null>;
  wattsSource?: 'device';
  /** Per-point device provenance (MZY-271): only when samples carry stamps. */
  sourceDevices?: SourceDevice[];
  heartrateSourceDevice?: Array<number | null>;
  cadenceSourceDevice?: Array<number | null>;
  velocitySourceDevice?: Array<number | null>;
  wattsSourceDevice?: Array<number | null>;
}

/**
 * Index-aligned ride_streams series merged from independently-notifying BLE
 * devices (HR strap, Speed Sensor 2, Cadence Sensor 2 — MZY-168; a power
 * meter — MZY-270, whose watts are labelled 'device') and, in the Android
 * app, the phone's GPS (MZY-282), on the shared 1 s axis (see `alignment`).
 * A metric absent for the WHOLE recording (that sensor was never connected)
 * is omitted entirely, not sent as all-null.
 *
 * Speed comes from the wheel sensor whenever it reported at all, else from
 * the GPS fixes' own speed — chosen for the whole ride, never mixed per
 * second (the primary-device rule); `velocity_source_device` then points at
 * the phone GPS.
 */
export function toRideStreamData(
  samples: RideStreamSamples,
  startedAtMs: number,
): RideStreamData {
  const power = samples.power ?? [];
  const gps = samples.gps ?? [];
  const a = alignment(startedAtMs, [
    ...samples.hr,
    ...samples.speed,
    ...samples.cadence,
    ...power,
    ...gps,
  ]);

  const hrByT = a.bySecond(samples.hr, (s) => s.bpm);
  // ride_streams.cadence is INTEGER[]; the CSC/power crank maths gives a
  // fractional rpm (revs ÷ event time), so store whole rpm like Strava does.
  const cadenceByT = a.bySecond(samples.cadence, (s) => Math.round(s.rpm));
  // velocity_smooth_mps is m/s by convention (see services/runStreams.ts); speed
  // samples are captured in km/h (the athlete-facing unit) so convert here.
  const speedByT =
    samples.speed.length > 0
      ? a.bySecond(samples.speed, (s) => s.speedKmh / 3.6)
      : gpsSpeedSlots(a, gps);
  const powerByT = a.bySecond(power, (s) => s.watts);

  const timeS = axisOf(
    hrByT.keys(),
    cadenceByT.keys(),
    speedByT.keys(),
    powerByT.keys(),
    gps.map((s) => a.bucket(s.tMs)),
  );

  const out: RideStreamData = {
    timeS,
    heartrate: valuesOn(timeS, hrByT),
    cadence: valuesOn(timeS, cadenceByT),
    velocitySmoothMps: valuesOn(timeS, speedByT),
    ...(powerByT.size > 0
      ? { watts: valuesOn(timeS, powerByT), wattsSource: 'device' as const }
      : {}),
    ...gpsStreams(gps, timeS, a.bucket),
  };
  if (a.sourceDevices.length > 0) {
    out.sourceDevices = a.sourceDevices;
    out.heartrateSourceDevice = devicesOn(timeS, hrByT);
    out.cadenceSourceDevice = devicesOn(timeS, cadenceByT);
    out.velocitySourceDevice = devicesOn(timeS, speedByT);
    out.wattsSourceDevice = devicesOn(timeS, powerByT);
  }
  return out;
}

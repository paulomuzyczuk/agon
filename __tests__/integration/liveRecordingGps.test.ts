import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  finishLiveRecording,
  MissingDistanceError,
} from '@/services/liveRecording';
import { finishLiveRecordingRide } from '@/services/liveRecordingRide';
import type { GpsStreamSample } from '@/lib/liveRecordingStreams';
import { MERIDA_SILEX_400 } from '@/lib/gear';

// Integration lane (agon_test). MZY-282: a live recording's phone-GPS track
// is flushed into run_streams/ride_streams (lat/lng/altitude/distance on the
// 1 s axis), gives start_lat/start_lng, and — without a typed distance —
// distance_km (GPS, else a ride's wheel sensor). Realistic fractional data:
// a ~2.9 m/s run north-east across Tempelhofer Feld, ±4 m accuracy.

const RUN_ID = 'itest-live-run-gps';
const GPS_ONLY_RUN_ID = 'itest-live-run-gps-only';
const NO_DISTANCE_RUN_ID = 'itest-live-run-no-distance';
const RIDE_ID = 'itest-live-ride-wheel';
const STARTED_AT = Date.parse('2020-03-03T07:00:00Z');
const LAT0 = 52.4731234;
const LNG0 = 13.4012345;
const M_PER_DEG_LNG = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

const PHONE = {
  deviceId: 'phone-gps',
  deviceName: 'Phone GPS',
  deviceKind: 'gps' as const,
};

/** 10 min, one fix per second (0.27 s late), 2.1 m/s north + 2.05 m/s east. */
function track(seconds = 600): GpsStreamSample[] {
  return Array.from({ length: seconds + 1 }, (_, s) => ({
    tMs: STARTED_AT + s * 1000 + 270,
    lat: LAT0 + (s * 2.1) / 111_320,
    lng: LNG0 + (s * 2.05) / M_PER_DEG_LNG,
    altitudeM: 41.3 + Math.sin(s / 30) * 1.7,
    accuracyM: 3.6 + (s % 4) * 0.35,
    speedMps: 2.9347,
    ...PHONE,
  }));
}

const hr = (seconds: number) =>
  Array.from({ length: seconds * 2 }, (_, i) => ({
    tMs: STARTED_AT + i * 500 + 40,
    bpm: 140 + (i % 7),
    sensorContact: 'supported-detected',
    deviceId: '00:00:5E:00:53:01',
    deviceName: 'HRM 200',
    deviceKind: 'heart_rate' as const,
  }));

// finishLiveRecordingRide registers the bike — a gear row the ride cascade
// doesn't remove, and other suites (telegramHandlers /maintained) assert a
// single test bike. Drop it again unless it was already there.
const BIKE_GEAR_ID = MERIDA_SILEX_400.gear_id;
let bikePreexisted = false;

beforeAll(async () => {
  loadEnv();
  const { rows } = await query('SELECT 1 FROM public.gear WHERE gear_id = $1', [
    BIKE_GEAR_ID,
  ]);
  bikePreexisted = rows.length > 0;
});

afterAll(async () => {
  await query(
    `DELETE FROM public.runs WHERE source = 'live_recording' AND external_id = ANY($1)`,
    [[RUN_ID, GPS_ONLY_RUN_ID, NO_DISTANCE_RUN_ID]],
  );
  await query(
    `DELETE FROM public.rides WHERE source = 'live_recording' AND external_id = $1`,
    [RIDE_ID],
  );
  if (!bikePreexisted) {
    await query('DELETE FROM public.gear WHERE gear_id = $1', [BIKE_GEAR_ID]);
  }
  await closeDbPool();
});

interface StreamRow {
  time_s: number[];
  heartrate: number[] | null;
  lat: string[] | null;
  lng: string[] | null;
  altitude_m: string[] | null;
  distance_m: string[] | null;
  velocity_smooth_mps: string[] | null;
  source_devices: Array<{ name: string; kind: string; ble_id: string }>;
}

describe('finishLiveRecording — GPS track', () => {
  it('stores route, distance and start position, deriving distance_km', async () => {
    const input = {
      recordingId: RUN_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 601_000,
      deviceName: 'HRM 200',
      samples: hr(600),
      gps: track(),
    };
    const first = await finishLiveRecording(input);
    expect(first.distanceSource).toBe('gps');

    const { rows: runs } = await query<{
      distance_km: string;
      start_lat: number;
      start_lng: number;
      avg_pace_s_per_km: string;
      elevation_gain_m: string | null;
    }>(
      'SELECT distance_km, start_lat, start_lng, avg_pace_s_per_km, elevation_gain_m FROM public.runs WHERE id = $1',
      [first.runId],
    );
    // 601 s × √(2.1² + 2.05²) ≈ 1764 m
    expect(Number(runs[0]!.distance_km)).toBeCloseTo(1.764, 1);
    expect(runs[0]!.start_lat).toBeCloseTo(LAT0, 7);
    expect(runs[0]!.start_lng).toBeCloseTo(LNG0, 7);
    // MZY-295: the ±1.7 m altitude wave rises ~1.7 + 2 × 3.4 m over the
    // run; smoothing (100 m window) shaves the crests.
    expect(Number(runs[0]!.elevation_gain_m)).toBeGreaterThan(5);
    expect(Number(runs[0]!.elevation_gain_m)).toBeLessThan(10);

    const { rows } = await query<StreamRow>(
      `SELECT time_s, heartrate, lat, lng, altitude_m, distance_m,
              velocity_smooth_mps, source_devices
         FROM public.run_streams WHERE run_id = $1`,
      [first.runId],
    );
    const s = rows[0]!;
    const n = s.time_s.length;
    expect(n).toBe(601); // 2 Hz HR + 1 Hz GPS on one 1 s axis
    for (const arr of [s.heartrate, s.lat, s.lng, s.altitude_m, s.distance_m]) {
      expect(arr).toHaveLength(n);
    }
    expect(Number(s.lat![10])).toBeCloseTo(LAT0 + 21 / 111_320, 6);
    expect(Number(s.altitude_m![0])).toBeCloseTo(41.3, 1);
    expect(Number(s.distance_m!.at(-1))).toBeCloseTo(
      Number(runs[0]!.distance_km) * 1000,
      -1,
    );
    expect(Number(s.velocity_smooth_mps![5])).toBe(2.93);
    expect(s.source_devices).toEqual([
      { name: 'HRM 200', kind: 'heart_rate', ble_id: '00:00:5E:00:53:01' },
      { name: 'Phone GPS', kind: 'gps', ble_id: 'phone-gps' },
    ]);

    // A retried flush updates the same row.
    const retry = await finishLiveRecording(input);
    expect(retry).toMatchObject({ runId: first.runId, status: 'updated' });
  });

  it('saves a GPS-only run (no strap) with null HR', async () => {
    const { runId } = await finishLiveRecording({
      recordingId: GPS_ONLY_RUN_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 121_000,
      deviceName: 'Phone GPS',
      samples: [],
      gps: track(120),
    });
    const { rows } = await query<{
      avg_hr: number | null;
      distance_km: string;
    }>('SELECT avg_hr, distance_km FROM public.runs WHERE id = $1', [runId]);
    expect(rows[0]!.avg_hr).toBeNull();
    expect(Number(rows[0]!.distance_km)).toBeGreaterThan(0.3);
  });

  it('a typed distance still wins over the track', async () => {
    const { runId, distanceSource } = await finishLiveRecording({
      recordingId: RUN_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 601_000,
      deviceName: 'HRM 200',
      samples: hr(600),
      gps: track(),
      distanceKm: 1.8,
    });
    expect(distanceSource).toBe('manual');
    const { rows } = await query<{ distance_km: string }>(
      'SELECT distance_km FROM public.runs WHERE id = $1',
      [runId],
    );
    expect(Number(rows[0]!.distance_km)).toBe(1.8);
  });

  it('refuses without a typed distance or a track, writing nothing', async () => {
    await expect(
      finishLiveRecording({
        recordingId: NO_DISTANCE_RUN_ID,
        startedAt: STARTED_AT,
        endedAt: STARTED_AT + 60_000,
        deviceName: 'HRM 200',
        samples: hr(60),
      }),
    ).rejects.toBeInstanceOf(MissingDistanceError);
    const { rows } = await query(
      `SELECT 1 FROM public.runs WHERE source = 'live_recording' AND external_id = $1`,
      [NO_DISTANCE_RUN_ID],
    );
    expect(rows).toHaveLength(0);
  });
});

describe('finishLiveRecordingRide — wheel distance without GPS', () => {
  it('derives distance_km from the wheel-revolution counter', async () => {
    const speed = Array.from({ length: 300 }, (_, s) => ({
      tMs: STARTED_AT + s * 1000 + 120,
      speedKmh: 27.4 + (s % 3) * 0.13,
      wheelRevs: 4_000_000 + s * 3.4,
      deviceId: '00:00:5E:00:53:02',
      deviceName: 'SPD-BLE0713708',
      deviceKind: 'csc' as const,
    })).map((x) => ({ ...x, wheelRevs: Math.floor(x.wheelRevs) }));
    const { rideId, distanceSource } = await finishLiveRecordingRide({
      recordingId: RIDE_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 300_000,
      samples: { hr: [], speed, cadence: [], power: [], gps: [] },
    });
    expect(distanceSource).toBe('wheel');
    const { rows } = await query<{
      distance_km: string;
      start_lat: string | null;
    }>('SELECT distance_km, start_lat FROM public.rides WHERE id = $1', [
      rideId,
    ]);
    // floor(299 × 3.4) = 1016 revs × 2.242 m
    expect(Number(rows[0]!.distance_km)).toBeCloseTo(2.278, 3);
    expect(rows[0]!.start_lat).toBeNull();
  });
});

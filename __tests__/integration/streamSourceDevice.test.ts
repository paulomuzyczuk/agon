import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { finishLiveRecordingRide } from '@/services/liveRecordingRide';
import { finishLiveRecording } from '@/services/liveRecording';
import { upsertRideStreams } from '@/services/runStreams';
import { upsertRide } from '@/services/strava/rideIngest';
import { MERIDA_SILEX_400 } from '@/lib/gear';
import { NO_RIDE_POWER, type RideRecord } from '@/lib/types';

// Integration lane (agon_test). MZY-271: a live recording stores which device
// produced every point (source_devices + per-metric index arrays), the DB
// CHECKs accept it, and an import leaves all of it NULL.

const REC = 'itest-source-device';
const T0 = Date.parse('2020-04-01T09:00:00Z');
const strap = {
  deviceId: 'ble-h',
  deviceName: 'HRM 200',
  deviceKind: 'heart_rate' as const,
};
const pedals = {
  deviceId: 'ble-p',
  deviceName: 'Assioma',
  deviceKind: 'power' as const,
};
const trainer = {
  deviceId: 'ble-t',
  deviceName: 'KICKR',
  deviceKind: 'power' as const,
};

let bikePreexisted = false;

beforeAll(async () => {
  loadEnv();
  const { rows } = await query('SELECT 1 FROM public.gear WHERE gear_id = $1', [
    MERIDA_SILEX_400.gear_id,
  ]);
  bikePreexisted = rows.length > 0;
});

afterEach(async () => {
  for (const t of ['runs', 'rides']) {
    await query(`DELETE FROM public.${t} WHERE external_id = $1`, [REC]);
  }
});

afterAll(async () => {
  if (!bikePreexisted) {
    await query('DELETE FROM public.gear WHERE gear_id = $1', [
      MERIDA_SILEX_400.gear_id,
    ]);
  }
  await closeDbPool();
});

describe('source_device — live recordings', () => {
  it('stores per-point devices for a ride, including a power-meter switchover', async () => {
    const at = (s: number) => T0 + s * 1000;
    const { rideId } = await finishLiveRecordingRide({
      recordingId: REC,
      startedAt: T0,
      endedAt: at(4),
      samples: {
        hr: [0, 1, 2, 3].map((s) => ({ tMs: at(s), bpm: 130, ...strap })),
        speed: [],
        cadence: [],
        power: [
          { tMs: at(0), watts: 200, ...pedals },
          { tMs: at(1), watts: 205, ...pedals },
          // the pedals dropped out; the trainer became primary
          { tMs: at(3), watts: 210, ...trainer },
        ],
      },
      distanceKm: 1,
    });

    const { rows } = await query(
      `SELECT source_devices, heartrate_source_device, watts_source_device,
              cadence_source_device, velocity_source_device
         FROM public.ride_streams WHERE ride_id = $1`,
      [rideId],
    );
    expect(rows[0]).toEqual({
      source_devices: [
        { name: 'HRM 200', kind: 'heart_rate', ble_id: 'ble-h' },
        { name: 'Assioma', kind: 'power', ble_id: 'ble-p' },
        { name: 'KICKR', kind: 'power', ble_id: 'ble-t' },
      ],
      heartrate_source_device: [0, 0, 0, 0],
      watts_source_device: [1, 1, null, 2],
      cadence_source_device: null,
      velocity_source_device: null,
    });
  });

  it('stores the strap for every point of a live run', async () => {
    const { runId } = await finishLiveRecording({
      recordingId: REC,
      startedAt: T0,
      endedAt: T0 + 2000,
      deviceName: 'HRM 200',
      samples: [0, 1].map((s) => ({
        tMs: T0 + s * 1000,
        bpm: 140,
        sensorContact: 'supported-detected',
        ...strap,
      })),
      distanceKm: 1,
    });
    const { rows } = await query(
      `SELECT source_devices, heartrate_source_device
         FROM public.run_streams WHERE run_id = $1`,
      [runId],
    );
    expect(rows[0]).toEqual({
      source_devices: [
        { name: 'HRM 200', kind: 'heart_rate', ble_id: 'ble-h' },
      ],
      heartrate_source_device: [0, 0],
    });
  });

  it('leaves everything NULL for an import, and rejects a misaligned array', async () => {
    const { id } = await upsertRide({
      date: '2020-04-02',
      started_at: '2020-04-02T09:00:00Z',
      start_lat: null,
      start_lng: null,
      block: null,
      week: null,
      distance_km: 5,
      duration_s: 600,
      avg_hr: null,
      max_hr: null,
      avg_speed_kmh: 30,
      max_speed_kmh: 40,
      elevation_gain_m: 0,
      bike_used: null,
      ...NO_RIDE_POWER,
      external_id: REC,
      source: 'strava',
      origin: null,
    } as RideRecord);
    await upsertRideStreams(id, 'strava', {
      timeS: [0, 1],
      heartrate: [120, 121],
    });
    const { rows } = await query(
      `SELECT source_devices, heartrate_source_device FROM public.ride_streams WHERE ride_id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      source_devices: null,
      heartrate_source_device: null,
    });

    await expect(
      upsertRideStreams(id, 'strava', {
        timeS: [0, 1],
        heartrate: [120, 121],
        sourceDevices: [{ name: 'x', kind: 'heart_rate', ble_id: 'x' }],
        heartrateSourceDevice: [0], // one index for two samples
      }),
    ).rejects.toThrow(/ride_streams_source_device_aligned/);
  });
});

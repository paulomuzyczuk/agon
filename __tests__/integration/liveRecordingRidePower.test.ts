import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { finishLiveRecordingRide } from '@/services/liveRecordingRide';
import { MERIDA_SILEX_400 } from '@/lib/gear';

// Integration lane (agon_test). MZY-270: a live-recorded ride with BLE
// Cycling Power samples is stored with DEVICE provenance end to end —
// rides.power_source, ride_streams.watts_source — and gets its NP and power
// curve straight after the flush. Synthetic samples: no power meter exists yet.

const RECORDING_ID = 'itest-live-ride-power';
const STARTED_AT = Date.parse('2020-03-01T09:00:00Z');

/** `seconds` of 1 Hz samples, from the recording start. */
function samples(seconds: number, watts: (s: number) => number) {
  return Array.from({ length: seconds }, (_, s) => ({
    tMs: STARTED_AT + s * 1000,
    watts: watts(s),
  }));
}

// finishLiveRecordingRide registers the bike (upsertGear) — a gear row the
// ride cascade doesn't remove. Other suites assert "no active bike", so drop
// it again unless it was already there.
const BIKE_GEAR_ID = MERIDA_SILEX_400.gear_id;
let bikePreexisted = false;

beforeAll(async () => {
  loadEnv();
  const { rows } = await query('SELECT 1 FROM public.gear WHERE gear_id = $1', [
    BIKE_GEAR_ID,
  ]);
  bikePreexisted = rows.length > 0;
});

afterEach(async () => {
  await query(
    `DELETE FROM public.rides WHERE source = 'live_recording' AND external_id = $1`,
    [RECORDING_ID],
  );
});

afterAll(async () => {
  if (!bikePreexisted) {
    await query('DELETE FROM public.gear WHERE gear_id = $1', [BIKE_GEAR_ID]);
  }
  await closeDbPool();
});

describe('finishLiveRecordingRide — power meter', () => {
  it('stores device power + watts, and computes NP and the curve', async () => {
    const power = samples(1200, (s) => (s < 600 ? 200 : 300));
    const { rideId } = await finishLiveRecordingRide({
      recordingId: RECORDING_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 1200 * 1000,
      samples: {
        hr: power.map((p) => ({ tMs: p.tMs, bpm: 140 })),
        speed: [],
        cadence: [],
        power,
      },
      distanceKm: 10,
    });

    const { rows: rides } = await query(
      `SELECT avg_power_w, max_power_w, weighted_avg_power_w,
              kilojoules::float8 AS kj, power_source
         FROM public.rides WHERE id = $1`,
      [rideId],
    );
    expect(rides[0]).toEqual({
      avg_power_w: 250,
      max_power_w: 300,
      weighted_avg_power_w: null,
      kj: 300, // 200 W × 600 s + 300 W × 600 s
      power_source: 'device',
    });

    const { rows: streams } = await query(
      `SELECT watts_source, array_length(watts, 1) AS n
         FROM public.ride_streams WHERE ride_id = $1`,
      [rideId],
    );
    expect(streams).toEqual([{ watts_source: 'device', n: 1200 }]);

    const { rows: metrics } = await query(
      `SELECT np_w, stream_source FROM public.ride_power_metrics WHERE ride_id = $1`,
      [rideId],
    );
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.stream_source).toBe('live_recording');
    expect(metrics[0]!.np_w).toBeGreaterThan(250); // variable effort: NP > avg

    const { rows: curve } = await query(
      `SELECT count(*)::int AS n FROM public.ride_power_curve WHERE ride_id = $1`,
      [rideId],
    );
    expect(curve[0]!.n).toBe(10); // 1 s … 20 min
  });

  it('leaves power empty for a meter-less ride (no estimate is invented)', async () => {
    const { rideId } = await finishLiveRecordingRide({
      recordingId: RECORDING_ID,
      startedAt: STARTED_AT,
      endedAt: STARTED_AT + 60_000,
      samples: {
        hr: [{ tMs: STARTED_AT, bpm: 120 }],
        speed: [],
        cadence: [],
      },
      distanceKm: 1,
    });
    const { rows } = await query(
      `SELECT r.power_source, s.watts, s.watts_source,
              (SELECT count(*)::int FROM public.ride_power_metrics m WHERE m.ride_id = r.id) AS m
         FROM public.rides r JOIN public.ride_streams s ON s.ride_id = r.id
        WHERE r.id = $1`,
      [rideId],
    );
    expect(rows[0]).toEqual({
      power_source: null,
      watts: null,
      watts_source: null,
      m: 0,
    });
  });
});

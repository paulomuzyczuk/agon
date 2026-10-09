import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRide } from '@/services/strava/rideIngest';
import { upsertRideStreams } from '@/services/runStreams';
import { recomputeRidePowerMetrics } from '@/services/ridePowerMetrics';
import { NO_RIDE_POWER, type RideRecord } from '@/lib/types';

// Integration lane (agon_test). MZY-269's hard rule, against a real engine:
// ONLY a ride_streams row with watts_source = 'device' produces NP/IF/TSS and a
// power curve. An estimated series of the same shape produces nothing, and
// losing the device series removes the stale row. Synthetic watts only — no
// power meter exists yet.

const EXTERNAL_ID = 'itest-ride-power-metrics';
const FTP = [{ watts: 250, date: '2020-01-01' }];

function ride(): RideRecord {
  return {
    date: '2020-06-01',
    started_at: '2020-06-01T08:00:00Z',
    start_lat: null,
    start_lng: null,
    block: null,
    week: null,
    distance_km: 30,
    duration_s: 3600,
    avg_hr: null,
    max_hr: null,
    avg_speed_kmh: 30,
    max_speed_kmh: 45,
    elevation_gain_m: 100,
    bike_used: null,
    ...NO_RIDE_POWER,
    external_id: EXTERNAL_ID,
    source: 'strava',
    origin: null,
  } as RideRecord;
}

/** One hour at a constant 250 W, 1 Hz. */
const HOUR = {
  timeS: Array.from({ length: 3600 }, (_, i) => i),
  watts: Array.from({ length: 3600 }, () => 250),
};

async function metricsRow() {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT m.stream_source, m.ftp_w, m.np_w,
            m.intensity_factor::float8 AS if, m.tss::float8 AS tss,
            m.duration_s
       FROM public.ride_power_metrics m
       JOIN public.rides r ON r.id = m.ride_id
      WHERE r.external_id = $1`,
    [EXTERNAL_ID],
  );
  return rows[0] ?? null;
}

async function curveDurations(): Promise<number[]> {
  const { rows } = await query<{ duration_s: number }>(
    `SELECT c.duration_s FROM public.ride_power_curve c
       JOIN public.rides r ON r.id = c.ride_id
      WHERE r.external_id = $1 ORDER BY c.duration_s`,
    [EXTERNAL_ID],
  );
  return rows.map((r) => r.duration_s);
}

beforeAll(() => loadEnv());

afterEach(async () => {
  // ride_streams / ride_power_* cascade from rides.
  await query(
    `DELETE FROM public.rides WHERE source = 'strava' AND external_id = $1`,
    [EXTERNAL_ID],
  );
});

afterAll(() => closeDbPool());

describe('recomputeRidePowerMetrics — device-only gate', () => {
  it('computes nothing from an ESTIMATED watts series', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', {
      ...HOUR,
      wattsSource: 'estimated',
    });

    expect(await recomputeRidePowerMetrics(id, FTP)).toBeNull();
    expect(await metricsRow()).toBeNull();
    expect(await curveDurations()).toEqual([]);
  });

  it('writes metrics + curve from a DEVICE series', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', {
      ...HOUR,
      wattsSource: 'estimated',
    });
    await upsertRideStreams(id, 'live_recording', {
      ...HOUR,
      wattsSource: 'device',
    });

    await recomputeRidePowerMetrics(id, FTP);
    expect(await metricsRow()).toEqual({
      stream_source: 'live_recording',
      ftp_w: 250,
      np_w: 250,
      if: 1,
      tss: 100,
      duration_s: 3600,
    });
    expect(await curveDurations()).toEqual([
      1, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600,
    ]);
  });

  it('is idempotent, and drops the rows once the device series is gone', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'live_recording', {
      ...HOUR,
      wattsSource: 'device',
    });
    await recomputeRidePowerMetrics(id, FTP);
    await recomputeRidePowerMetrics(id, FTP);
    expect(await curveDurations()).toHaveLength(12);

    await query('DELETE FROM public.ride_streams WHERE ride_id = $1', [id]);
    expect(await recomputeRidePowerMetrics(id, FTP)).toBeNull();
    expect(await metricsRow()).toBeNull();
    expect(await curveDurations()).toEqual([]);
  });

  it('stores NP without IF/TSS when no FTP applies (the CHECK allows it)', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'live_recording', {
      ...HOUR,
      wattsSource: 'device',
    });
    await recomputeRidePowerMetrics(id, undefined);
    expect(await metricsRow()).toMatchObject({
      np_w: 250,
      ftp_w: null,
      if: null,
      tss: null,
    });
  });
});

import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRun } from '@/services/strava/ingest';
import { upsertRide } from '@/services/strava/rideIngest';
import { correctRide, correctRun } from '@/services/activityCorrections';
import { NO_RIDE_POWER, type RideRecord, type RunRecord } from '@/lib/types';

// A hand-corrected run/ride column survives a source re-sync; uncorrected
// columns still follow the source.

const EXTERNAL_ID = 'itest-activity-corrections';

function ride(overrides: Partial<RideRecord> = {}): RideRecord {
  return {
    date: '2020-01-01',
    started_at: '2020-01-01T10:00:00Z',
    start_lat: null,
    start_lng: null,
    block: null,
    week: null,
    distance_km: 6.771,
    duration_s: 1268,
    avg_hr: null,
    max_hr: null,
    avg_speed_kmh: 19.22,
    max_speed_kmh: 32.11,
    elevation_gain_m: 10,
    bike_used: null,
    ...NO_RIDE_POWER,
    external_id: EXTERNAL_ID,
    source: 'strava',
    origin: null,
    ...overrides,
  } as RideRecord;
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    date: '2020-01-01',
    started_at: '2020-01-01T10:00:00Z',
    start_lat: null,
    start_lng: null,
    block: null,
    week: null,
    distance_km: 10,
    duration_s: 3000,
    avg_hr: 150,
    max_hr: 171,
    avg_pace_s_per_km: 300,
    elevation_gain_m: 42,
    shoe_used: null,
    strava_activity_id: null,
    external_id: EXTERNAL_ID,
    source: 'strava',
    origin: null,
    ...overrides,
  } as RunRecord;
}

async function stored(
  table: 'runs' | 'rides',
): Promise<Record<string, unknown>> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT distance_km::float8 AS distance_km, duration_s,
            elevation_gain_m::float8 AS elevation_gain_m, corrected_fields
       FROM public.${table} WHERE source = 'strava' AND external_id = $1`,
    [EXTERNAL_ID],
  );
  return rows[0]!;
}

beforeAll(() => loadEnv());

afterEach(async () => {
  for (const t of ['runs', 'rides']) {
    await query(
      `DELETE FROM public.${t} WHERE source = 'strava' AND external_id = $1`,
      [EXTERNAL_ID],
    );
  }
});

afterAll(() => closeDbPool());

describe('ride hand corrections', () => {
  it('keeps corrected columns on re-sync and updates the rest', async () => {
    const { id } = await upsertRide(ride());
    await correctRide(id, {
      distance_km: 7.771,
      duration_s: 1431,
      avg_speed_kmh: 19.55,
    });

    const again = await upsertRide(ride({ elevation_gain_m: 12 }));
    expect(again).toEqual({ id, status: 'updated' });

    expect(await stored('rides')).toEqual({
      distance_km: 7.771,
      duration_s: 1431,
      elevation_gain_m: 12,
      corrected_fields: ['avg_speed_kmh', 'distance_km', 'duration_s'],
    });
  });

  it('ignores columns the source does not own', async () => {
    const { id } = await upsertRide(ride());
    await correctRide(id, { general_notes: 'x' } as never);
    expect((await stored('rides')).corrected_fields).toEqual([]);
  });
});

describe('ride power corrections (MZY-267)', () => {
  async function storedPower(): Promise<Record<string, unknown>> {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT avg_power_w, kilojoules::float8 AS kilojoules, power_source
         FROM public.rides WHERE source = 'strava' AND external_id = $1`,
      [EXTERNAL_ID],
    );
    return rows[0]!;
  }
  const estimated = {
    avg_power_w: 110,
    kilojoules: 300,
    power_source: 'estimated' as const,
  };

  it('labels a hand-corrected watt value manual', async () => {
    const { id } = await upsertRide(ride(estimated));
    await correctRide(id, { avg_power_w: 150 });
    expect(await storedPower()).toEqual({
      avg_power_w: 150,
      kilojoules: 300,
      power_source: 'manual',
    });
  });

  it('keeps the whole power group when any of it was corrected', async () => {
    const { id } = await upsertRide(ride(estimated));
    await correctRide(id, { avg_power_w: 150 });
    // Strava re-sync with a new estimate: neither the corrected avg nor the
    // uncorrected kJ may change, or kJ would be an estimate labelled manual.
    await upsertRide(ride({ ...estimated, avg_power_w: 95, kilojoules: 280 }));
    expect(await storedPower()).toEqual({
      avg_power_w: 150,
      kilojoules: 300,
      power_source: 'manual',
    });
  });

  it('follows the source when no power column was corrected', async () => {
    const { id } = await upsertRide(ride(estimated));
    await correctRide(id, { distance_km: 7 });
    await upsertRide(ride({ ...estimated, avg_power_w: 95 }));
    expect((await storedPower()).avg_power_w).toBe(95);
  });
});

describe('run hand corrections', () => {
  it('keeps corrected columns on re-sync and updates the rest', async () => {
    const { id } = await upsertRun(run());
    await correctRun(id, { distance_km: 10.5, duration_s: 3150 });
    await correctRun(id, { distance_km: 10.6 });

    const again = await upsertRun(run({ elevation_gain_m: 50 }));
    expect(again).toEqual({ id, status: 'updated' });

    expect(await stored('runs')).toEqual({
      distance_km: 10.6,
      duration_s: 3150,
      elevation_gain_m: 50,
      corrected_fields: ['distance_km', 'duration_s'],
    });
  });
});

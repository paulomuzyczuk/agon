import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRun } from '@/services/strava/ingest';
import { upsertRide } from '@/services/strava/rideIngest';
import { upsertRideStreams, upsertRunStreams } from '@/services/runStreams';
import {
  applyCorrection,
  previewCorrection,
  revertCorrectionGroup,
  streamCutColumns,
} from '@/services/activityCorrectionFlow';
import { classifyIncomingActivity } from '@/services/activitySources';
import { fetchRunWeather } from '@/services/weather/openMeteo';
import { CorrectionError } from '@/lib/activityCorrection';
import type { RideRecord, RunRecord } from '@/lib/types';

// Integration lane (agon_test) for the PWA correction flow (MZY-253): the
// corrected totals, the moved start, the stream cut, provenance, the derived
// re-score, survival across a source re-sync, source-overlap matching on the
// source's own start, and the revert. Open-Meteo is mocked.

jest.mock('@/services/weather/openMeteo', () => ({
  ...jest.requireActual('@/services/weather/openMeteo'),
  fetchRunWeather: jest.fn(),
}));
const fetchMock = fetchRunWeather as jest.MockedFunction<
  typeof fetchRunWeather
>;

const EXT = 'itest-mzy253';
const START = '2026-09-29T19:21:36.000Z';

function ride(overrides: Partial<RideRecord> = {}): RideRecord {
  return {
    date: '2026-09-29',
    started_at: START,
    start_lat: 52.5,
    start_lng: 13.4,
    block: null,
    week: null,
    distance_km: 7.06,
    duration_s: 1030,
    avg_hr: 140,
    max_hr: 150,
    avg_speed_kmh: 24.68,
    max_speed_kmh: 30,
    elevation_gain_m: 10,
    bike_used: null,
    external_id: EXT,
    source: 'strava',
    origin: null,
    ...overrides,
  } as RideRecord;
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    date: '2026-09-29',
    started_at: '2026-09-29T06:00:00.000Z',
    start_lat: 52.5,
    start_lng: 13.4,
    block: null,
    week: null,
    distance_km: 5.06,
    duration_s: 1530,
    avg_hr: 150,
    max_hr: 165,
    avg_pace_s_per_km: 302.37,
    elevation_gain_m: 5,
    shoe_used: null,
    strava_activity_id: null,
    external_id: EXT,
    source: 'strava',
    origin: null,
    ...overrides,
  } as RunRecord;
}

/**
 * 1 Hz stream: `fast` s at `speed` m/s, then a 30 s walk at 2 m/s (moving),
 * then 150 s standing still — the "left it running at home" tail.
 */
function stream(fast: number, speed: number) {
  const timeS: number[] = [0];
  const distanceM: number[] = [0];
  const moving: boolean[] = [true];
  const push = (secs: number, v: number, mv: boolean) => {
    for (let i = 0; i < secs; i++) {
      timeS.push(timeS.length);
      distanceM.push(distanceM[distanceM.length - 1]! + v);
      moving.push(mv);
    }
  };
  push(fast, speed, true);
  push(30, 2, true);
  push(150, 0, false);
  const n = timeS.length;
  return {
    timeS,
    distanceM,
    moving,
    heartrate: Array.from({ length: n }, () => 140),
    lat: Array.from({ length: n }, (_, i) => 52.5 + i * 1e-5),
    lng: Array.from({ length: n }, () => 13.4),
  };
}

async function rideRow(id: string) {
  const { rows } = await query<{
    distance_km: number;
    duration_s: number;
    avg_speed_kmh: number;
    started_at: Date;
    source_started_at: Date | null;
    corrected_fields: string[];
    general_notes: string | null;
    temp_c: number | null;
  }>(
    `SELECT distance_km::float8 AS distance_km, duration_s,
            avg_speed_kmh::float8 AS avg_speed_kmh, started_at, source_started_at,
            corrected_fields, general_notes, temp_c::float8 AS temp_c
       FROM public.rides WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

beforeAll(() => loadEnv());

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    tempC: 12,
    humidityPct: 70,
    windKph: 10,
    conditions: 'Overcast',
  });
});

afterEach(async () => {
  await query(
    `DELETE FROM public.qualitative_logs
      WHERE parsed_json->>'source' = 'manual_correction'
        AND (parsed_json->>'rideId' IN (SELECT id::text FROM public.rides WHERE external_id = $1)
          OR parsed_json->>'runId' IN (SELECT id::text FROM public.runs WHERE external_id = $1))`,
    [EXT],
  );
  for (const t of ['runs', 'rides']) {
    await query(`DELETE FROM public.${t} WHERE external_id LIKE $1`, [
      `${EXT}%`,
    ]);
  }
  await query(
    `DELETE FROM public.training_load_daily WHERE date >= '2026-09-29'`,
  );
});

afterAll(() => closeDbPool());

describe('ride: missed start + late stop (the 2026-09-29 ride-2 shape)', () => {
  it('previews without writing anything', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', stream(1000, 7));
    const p = await previewCorrection('ride', id, [
      { kind: 'missed_start', addKm: 0.5 },
      { kind: 'late_stop', trimMin: 3 },
    ]);
    expect(p.plan.after.distanceKm).toBe(7.5);
    expect(p.plan.after.durationS).toBe(1071);
    expect(p.rate.after).toBe(25.21);
    const row = await rideRow(id);
    expect(row.distance_km).toBe(7.06);
    expect(row.corrected_fields).toEqual([]);
  });

  it('writes totals, moves the start, cuts streams, records provenance, re-scores', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', stream(1000, 7));

    const result = await applyCorrection(
      'ride',
      id,
      [
        { kind: 'missed_start', addKm: 0.5 },
        { kind: 'late_stop', trimMin: 3 },
      ],
      'Forgot to start Strava, and to stop it at home.',
    );
    expect(result.derived.failed).toEqual([]);
    expect(result.derived.ok).toEqual([
      'weather',
      'relative_effort',
      'power_metrics', // MZY-269 — runs, but writes nothing without device watts
      'fueling_balance',
      'training_load',
    ]);

    const row = await rideRow(id);
    expect(row.distance_km).toBe(7.5);
    expect(row.duration_s).toBe(1071);
    expect(row.avg_speed_kmh).toBe(25.21);
    // first km at 143 s over 1001 m → 0.5 km = 71 s earlier
    expect(row.started_at.toISOString()).toBe('2026-09-29T19:20:25.000Z');
    expect(row.source_started_at!.toISOString()).toBe(START);
    expect(row.corrected_fields).toEqual([
      'avg_speed_kmh',
      'distance_km',
      'duration_s',
      'started_at',
    ]);
    expect(row.general_notes!.split('\n')).toHaveLength(2);
    expect(row.temp_c).toBe(12);
    expect(fetchMock).toHaveBeenCalledWith(
      52.5,
      13.4,
      '2026-09-29T19:20:25.000Z',
    );

    const { rows: streams } = await query<{
      sample_count: number;
      lens: number[];
      max_t: number;
    }>(
      `SELECT sample_count,
              ARRAY[cardinality(time_s), cardinality(distance_m), cardinality(moving),
                    cardinality(heartrate), cardinality(lat), cardinality(lng)] AS lens,
              time_s[cardinality(time_s)] AS max_t
         FROM public.ride_streams WHERE ride_id = $1`,
      [id],
    );
    expect(streams[0]).toEqual({
      sample_count: 1001,
      lens: [1001, 1001, 1001, 1001, 1001, 1001],
      max_t: 1000,
    });

    const { rows: logs } = await query<{
      session_type: string;
      raw_transcript: string;
      parsed_json: {
        source: string;
        rideId: string;
        stravaActivityId: string;
        corrections: Array<{
          kind: string;
          distance_km: number;
          duration_s: number;
        }>;
      };
    }>(
      `SELECT session_type, raw_transcript, parsed_json FROM public.qualitative_logs
        WHERE parsed_json->>'rideId' = $1`,
      [id],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.session_type).toBe('ride');
    expect(logs[0]!.raw_transcript).toMatch(/Forgot to start/);
    expect(logs[0]!.parsed_json).toMatchObject({
      source: 'manual_correction',
      rideId: id,
      stravaActivityId: EXT,
      corrections: [
        { kind: 'missed_start', distance_km: 0.5, duration_s: 71 },
        { kind: 'late_stop_trim', distance_km: -0.06, duration_s: -30 },
      ],
    });

    const { rows: re } = await query<{ duration_s: number; method: string }>(
      'SELECT duration_s, method FROM public.ride_relative_effort WHERE ride_id = $1',
      [id],
    );
    expect(re).toEqual([{ duration_s: 1071, method: 'stream' }]);
    const { rows: tl } = await query(
      `SELECT 1 FROM public.training_load_daily WHERE date = '2026-09-29'`,
    );
    expect(tl).toHaveLength(1);
  });

  it('survives a source re-sync, including the moved start', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', stream(1000, 7));
    await applyCorrection(
      'ride',
      id,
      [{ kind: 'missed_start', addKm: 0.5 }],
      null,
    );

    await upsertRide(ride({ elevation_gain_m: 12 }));
    const row = await rideRow(id);
    expect(row.distance_km).toBe(7.56);
    expect(row.started_at.toISOString()).toBe('2026-09-29T19:20:25.000Z');
    expect(row.source_started_at!.toISOString()).toBe(START);
  });

  it('still matches a higher-priority twin at the SOURCE start after a >5 min shift', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', stream(1000, 7));
    // 3 km at ~143 s/km moves the start ~429 s — past the 5-min supersede window
    await applyCorrection(
      'ride',
      id,
      [{ kind: 'missed_start', addKm: 3 }],
      null,
    );
    const moved = await rideRow(id);
    expect(Date.parse(START) - moved.started_at.getTime()).toBe(429_000);

    const p = await classifyIncomingActivity('ride', {
      source: 'live_recording',
      external_id: `${EXT}-twin`,
      started_at: new Date(Date.parse(START) + 20_000).toISOString(),
      duration_s: 1000,
    });
    expect(p.supersede.map((s) => s.id)).toEqual([id]);
    expect(p.ambiguous).toEqual([]);
  });

  it('reverts the start exactly and hands the totals back to the source', async () => {
    const { id } = await upsertRide(ride());
    await upsertRideStreams(id, 'strava', stream(1000, 7));
    await applyCorrection(
      'ride',
      id,
      [{ kind: 'missed_start', addKm: 0.5 }],
      null,
    );

    const start = await revertCorrectionGroup('ride', id, 'start');
    expect(start.reverted).toEqual(['started_at']);
    let row = await rideRow(id);
    expect(row.started_at.toISOString()).toBe(START);
    expect(row.source_started_at).toBeNull();

    const totals = await revertCorrectionGroup('ride', id, 'totals');
    expect(totals.reverted).toEqual([
      'avg_speed_kmh',
      'distance_km',
      'duration_s',
    ]);
    await upsertRide(ride());
    row = await rideRow(id);
    expect(row.distance_km).toBe(7.06);
    expect(row.corrected_fields).toEqual([]);
  });

  it('refuses a trim on an activity without a stream', async () => {
    const { id } = await upsertRide(ride());
    await expect(
      applyCorrection('ride', id, [{ kind: 'late_stop', trimMin: 3 }], null),
    ).rejects.toBeInstanceOf(CorrectionError);
    expect((await rideRow(id)).corrected_fields).toEqual([]);
  });
});

describe('run: late stop + totals', () => {
  it('cuts run-only stream arrays too, recomputes pace and best efforts', async () => {
    const { id } = await upsertRun(run());
    const s = stream(1500, 10 / 3);
    await upsertRunStreams(id, 'strava', s);
    await query(
      `UPDATE public.run_streams
          SET derived_moving = moving,
              fitbit_cadence = array_fill(170, ARRAY[$2::int])
        WHERE run_id = $1`,
      [id, s.timeS.length],
    );

    const result = await applyCorrection(
      'run',
      id,
      [{ kind: 'late_stop', trimMin: 3 }],
      null,
    );
    expect(result.derived.failed).toEqual([]);
    expect(result.derived.ok).toContain('best_efforts');

    const { rows } = await query<{
      distance_km: number;
      duration_s: number;
      avg_pace_s_per_km: number;
      corrected_fields: string[];
    }>(
      `SELECT distance_km::float8 AS distance_km, duration_s,
              avg_pace_s_per_km::float8 AS avg_pace_s_per_km, corrected_fields
         FROM public.runs WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      distance_km: 5,
      duration_s: 1500,
      avg_pace_s_per_km: 300,
      corrected_fields: ['avg_pace_s_per_km', 'distance_km', 'duration_s'],
    });

    const { rows: st } = await query<{ lens: number[] }>(
      `SELECT ARRAY[sample_count, cardinality(time_s), cardinality(derived_moving),
                    cardinality(fitbit_cadence)] AS lens
         FROM public.run_streams WHERE run_id = $1`,
      [id],
    );
    expect(st[0]!.lens).toEqual([1501, 1501, 1501, 1501]);

    const { rows: be } = await query<{ distance_m: number }>(
      `SELECT distance_m::float8 AS distance_m FROM public.run_best_efforts
        WHERE run_id = $1 AND effort_name = 'full_run'`,
      [id],
    );
    expect(be[0]!.distance_m).toBeCloseTo(5000, 0);
  });

  it('free-edits totals with pace derived', async () => {
    const { id } = await upsertRun(run());
    await applyCorrection(
      'run',
      id,
      [{ kind: 'totals', distanceKm: 5.1 }],
      null,
    );
    const { rows } = await query<{ avg_pace_s_per_km: number }>(
      'SELECT avg_pace_s_per_km::float8 AS avg_pace_s_per_km FROM public.runs WHERE id = $1',
      [id],
    );
    expect(rows[0]!.avg_pace_s_per_km).toBe(300);
  });
});

// Live recordings (MZY-271) carry per-point device indices and, with a power
// meter, watts. ride_streams_source_device_aligned requires every
// *_source_device array to match time_s, so a late-stop cut that misses one
// fails the whole correction (found trimming the 2026-10-18 ride, whose last
// 112 s were standing still).
describe('late stop on a live-recorded stream', () => {
  const DEVICES = [
    { name: 'HRM 200', kind: 'heart_rate' as const, ble_id: 'hr-1' },
    { name: 'Speed', kind: 'csc' as const, ble_id: 'spd-1' },
  ];

  function live() {
    const s = stream(1000, 7);
    const n = s.timeS.length;
    const idx = (i: number) => Array.from({ length: n }, () => i);
    return {
      ...s,
      cadence: Array.from({ length: n }, () => 80),
      velocitySmoothMps: Array.from({ length: n }, () => 7),
      sourceDevices: DEVICES,
      heartrateSourceDevice: idx(0),
      cadenceSourceDevice: idx(1),
      velocitySourceDevice: idx(1),
      n,
    };
  }

  it('cuts every ride device array and watts together with time_s', async () => {
    const { id } = await upsertRide(
      ride({ source: 'live_recording', external_id: `${EXT}-live` }),
    );
    const { n, ...data } = live();
    await upsertRideStreams(id, 'live_recording', {
      ...data,
      watts: Array.from({ length: n }, () => 150),
      wattsSource: 'device',
      wattsSourceDevice: Array.from({ length: n }, () => 1),
    });

    await applyCorrection(
      'ride',
      id,
      [{ kind: 'late_stop', trimMin: 3 }],
      null,
    );

    const { rows } = await query<{ lens: number[] }>(
      `SELECT ARRAY[sample_count, cardinality(time_s), cardinality(heartrate),
                    cardinality(cadence), cardinality(velocity_smooth_mps),
                    cardinality(watts), cardinality(heartrate_source_device),
                    cardinality(cadence_source_device),
                    cardinality(velocity_source_device),
                    cardinality(watts_source_device)] AS lens
         FROM public.ride_streams WHERE ride_id = $1`,
      [id],
    );
    const kept = rows[0]!.lens[0]!;
    expect(kept).toBeLessThan(n);
    expect(rows[0]!.lens).toEqual(Array.from({ length: 10 }, () => kept));
  });

  it('cuts a live-recorded run heartrate_source_device with time_s', async () => {
    const { id } = await upsertRun(
      run({ source: 'live_recording', external_id: `${EXT}-live` }),
    );
    const { n, ...data } = live();
    await upsertRunStreams(id, 'live_recording', {
      timeS: data.timeS,
      distanceM: data.distanceM,
      moving: data.moving,
      heartrate: data.heartrate,
      sourceDevices: DEVICES,
      heartrateSourceDevice: data.heartrateSourceDevice,
    });

    await applyCorrection('run', id, [{ kind: 'late_stop', trimMin: 3 }], null);

    const { rows } = await query<{ lens: number[] }>(
      `SELECT ARRAY[sample_count, cardinality(time_s),
                    cardinality(heartrate_source_device)] AS lens
         FROM public.run_streams WHERE run_id = $1`,
      [id],
    );
    const kept = rows[0]!.lens[0]!;
    expect(kept).toBeLessThan(n);
    expect(rows[0]!.lens).toEqual([kept, kept, kept]);
  });
});

// The cut list is hand-kept, so a migration that adds a per-point array column
// would silently break every trim (or leave the new array longer than time_s).
describe('late-stop cut list', () => {
  it.each([
    ['ride', 'ride_streams'],
    ['run', 'run_streams'],
  ] as const)(
    'covers every array column of %s streams',
    async (kind, table) => {
      const { rows } = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
            AND data_type = 'ARRAY'`,
        [table],
      );
      expect([...streamCutColumns(kind)].sort()).toEqual(
        rows.map((r) => r.column_name).sort(),
      );
    },
  );
});

import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRunStreams, hasRunStreams } from '@/services/runStreams';
import { upsertRun } from '@/services/strava/ingest';
import type { RunRecord } from '@/lib/types';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves the compact-array storage round-trips through Postgres arrays: the
// series comes back index-aligned, upsert is idempotent, and hasRunStreams
// drives the resumable backfill.

const RUN_ID = 999_000_111_444;

function sampleRun(): RunRecord {
  return {
    date: '2026-08-01',
    started_at: '2026-08-01T09:00:00.000Z',
    start_lat: null,
    start_lng: null,
    block: 3,
    week: 19,
    distance_km: 5,
    duration_s: 1500,
    avg_hr: 150,
    max_hr: 165,
    avg_pace_s_per_km: 300,
    elevation_gain_m: 10,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: RUN_ID,
    external_id: String(RUN_ID),
    source: 'strava',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  // run_streams cascades from runs
  await query('DELETE FROM public.runs WHERE strava_activity_id = $1', [
    RUN_ID,
  ]);
});
afterAll(() => closeDbPool());

describe('run_streams storage', () => {
  it('round-trips aligned arrays and is idempotent', async () => {
    const { id } = await upsertRun(sampleRun());

    expect(await hasRunStreams(id, 'strava')).toBe(false);

    await upsertRunStreams(id, 'strava', {
      timeS: [0, 1, 2, 3],
      heartrate: [120, 131, 140, null],
      distanceM: [0, 3.1, 6.4, 9.0],
      moving: [false, true, true, true],
    });

    expect(await hasRunStreams(id, 'strava')).toBe(true);

    const { rows } = await query<{
      time_s: number[];
      heartrate: Array<number | null>;
      distance_m: string[];
      moving: boolean[];
      sample_count: number;
    }>(
      `SELECT time_s, heartrate, distance_m, moving, sample_count
         FROM public.run_streams WHERE run_id = $1 AND source = 'strava'`,
      [id],
    );
    const row = rows[0]!;
    expect(row.time_s).toEqual([0, 1, 2, 3]);
    expect(row.heartrate).toEqual([120, 131, 140, null]); // null sample preserved
    expect(row.distance_m.map(Number)).toEqual([0, 3.1, 6.4, 9.0]);
    expect(row.moving).toEqual([false, true, true, true]);
    expect(row.sample_count).toBe(4);

    // Re-upsert with a corrected series — replaces, one row still.
    await upsertRunStreams(id, 'strava', {
      timeS: [0, 1],
      heartrate: [122, 133],
    });
    const after = await query<{ count: string; sample_count: number }>(
      `SELECT count(*) OVER () AS count, sample_count
         FROM public.run_streams WHERE run_id = $1`,
      [id],
    );
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]!.sample_count).toBe(2);
  });
});

import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRun } from '@/services/strava/ingest';
import { upsertRunStreams } from '@/services/runStreams';
import {
  classifyIncomingActivity,
  supersedeActivities,
} from '@/services/activitySources';
import type { RunRecord } from '@/lib/types';

// Integration lane (agon_test DB) for the activity source priority (MZY-225):
// proves the overlap query and the loser→winner merge against real Postgres —
// streams/gear/fueling move, notes append, gaps fill, the loser row is gone.

const START = '2020-02-02T09:00:00.000Z';
const EXT = ['mzy225-gh', 'mzy225-strava', 'mzy225-far', 'mzy295-live'];

function run(over: Partial<RunRecord>): RunRecord {
  return {
    date: '2020-02-02',
    started_at: START,
    start_lat: null,
    start_lng: null,
    block: 1,
    week: 1,
    distance_km: 10,
    duration_s: 3000,
    avg_hr: null,
    max_hr: null,
    avg_pace_s_per_km: 300,
    elevation_gain_m: null,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: null,
    external_id: null,
    source: 'google_health',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
    ...over,
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.runs WHERE external_id = ANY($1)', [EXT]);
});
afterAll(() => closeDbPool());

describe('activity source priority (runs)', () => {
  it('a Strava run supersedes its Google Health twin and inherits what the twin knew', async () => {
    const gh = await upsertRun(
      run({
        external_id: 'mzy225-gh',
        started_at: '2020-02-02T08:59:20.000Z',
        avg_hr: 150,
        start_lat: 52.5,
        start_lng: 13.4,
      }),
    );
    await query(
      `UPDATE public.runs SET general_notes = 'gh note', temp_c = 12 WHERE id = $1`,
      [gh.id],
    );
    await upsertRunStreams(gh.id, 'fitbit', {
      timeS: [0, 1],
      heartrate: [140, 141],
    });
    await upsertRunStreams(gh.id, 'strava', { timeS: [0], heartrate: [1] });

    const incoming = run({
      source: 'strava',
      external_id: 'mzy225-strava',
      avg_hr: 155,
    });
    const p = await classifyIncomingActivity('run', incoming);
    expect(p.blocking).toEqual([]);
    expect(p.supersede.map((s) => s.id)).toEqual([gh.id]);

    const winner = await upsertRun(incoming);
    await upsertRunStreams(winner.id, 'strava', {
      timeS: [0, 1, 2],
      heartrate: [150, 151, 152],
    });
    await query(
      `UPDATE public.runs SET general_notes = 'strava note' WHERE id = $1`,
      [winner.id],
    );
    expect(await supersedeActivities('run', winner.id, p.supersede)).toBe(1);

    const { rows: gone } = await query(
      'SELECT 1 FROM public.runs WHERE id = $1',
      [gh.id],
    );
    expect(gone).toHaveLength(0);

    const { rows } = await query(
      `SELECT avg_hr, start_lat, temp_c, general_notes FROM public.runs WHERE id = $1`,
      [winner.id],
    );
    expect(rows[0]).toMatchObject({
      avg_hr: 155, // winner's own value kept
      start_lat: 52.5, // gap filled from the loser
      temp_c: '12.0', // NUMERIC → string via node-postgres
      general_notes: 'strava note | gh note',
    });

    const { rows: streams } = await query<{ source: string; n: number }>(
      `SELECT source, jsonb_array_length(to_jsonb(time_s)) AS n
         FROM public.run_streams WHERE run_id = $1 ORDER BY source`,
      [winner.id],
    );
    // fitbit moved over; the winner's own strava stream kept over the loser's.
    expect(streams).toEqual([
      { source: 'fitbit', n: 2 },
      { source: 'strava', n: 3 },
    ]);
  });

  it("an upstream gain wins over a live recording's GPS estimate (MZY-295)", async () => {
    const strava = await upsertRun(
      run({
        source: 'strava',
        external_id: 'mzy225-strava',
        elevation_gain_m: 42,
      }),
    );
    const live = await upsertRun(
      run({
        source: 'live_recording',
        external_id: 'mzy295-live',
        elevation_gain_m: 99.5,
      }),
    );
    await supersedeActivities('run', live.id, [
      { id: strava.id, source: 'strava', startedAtMs: Date.parse(START) },
    ]);
    const { rows } = await query<{ elevation_gain_m: string }>(
      'SELECT elevation_gain_m FROM public.runs WHERE id = $1',
      [live.id],
    );
    expect(Number(rows[0]!.elevation_gain_m)).toBe(42);
  });

  it('Google Health is blocked by a stored Strava twin', async () => {
    await upsertRun(run({ source: 'strava', external_id: 'mzy225-strava' }));
    const p = await classifyIncomingActivity(
      'run',
      run({ external_id: 'mzy225-gh', started_at: '2020-02-02T09:00:30.000Z' }),
    );
    expect(p.blocking.map((b) => b.source)).toEqual(['strava']);
    expect(p.supersede).toEqual([]);
  });

  it('holds back a loose overlap (>5 min start gap) instead of superseding it', async () => {
    await upsertRun(
      run({
        external_id: 'mzy225-far',
        started_at: '2020-02-02T08:50:00.000Z',
        duration_s: 5400,
      }),
    );
    const p = await classifyIncomingActivity(
      'run',
      run({ source: 'strava', external_id: 'mzy225-strava' }),
    );
    expect(p.supersede).toEqual([]);
    expect(p.ambiguous).toHaveLength(1);
  });
});

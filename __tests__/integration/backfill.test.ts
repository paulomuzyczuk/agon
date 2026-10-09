import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRun } from '@/services/strava/ingest';
import type { RunRecord } from '@/lib/types';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves what the unit suite structurally cannot: that the DDL actually applies,
// that the upsert is genuinely idempotent against a real engine, and — the
// property that matters most — that re-running the backfill does NOT clobber
// qualitative/weather enrichment written by later pipelines.

const TEST_ACTIVITY_ID = 999_000_111_222; // distinctive; unlikely to collide

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    date: '2026-03-25',
    started_at: '2026-03-25T09:00:00.000Z',
    start_lat: null,
    start_lng: null,
    block: 1,
    week: 1,
    distance_km: 10,
    duration_s: 3000,
    avg_hr: 150,
    max_hr: 171,
    avg_pace_s_per_km: 300,
    elevation_gain_m: 42,
    shoe_used: 'Endorphin Speed 4',
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: TEST_ACTIVITY_ID,
    external_id: String(TEST_ACTIVITY_ID),
    source: 'strava',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
    ...overrides,
  };
}

beforeAll(() => loadEnv());

afterEach(async () => {
  await query('DELETE FROM public.runs WHERE strava_activity_id = $1', [
    TEST_ACTIVITY_ID,
  ]);
});

afterAll(() => closeDbPool());

describe('upsertRun (idempotency + enrichment preservation)', () => {
  it('inserts a new run, then reports a re-run as an update', async () => {
    expect((await upsertRun(sampleRun())).status).toBe('inserted');
    expect((await upsertRun(sampleRun())).status).toBe('updated');

    const { rows } = await query<{ count: string }>(
      'SELECT count(*) FROM public.runs WHERE strava_activity_id = $1',
      [TEST_ACTIVITY_ID],
    );
    expect(rows[0]!.count).toBe('1'); // exactly one row — no duplicate
  });

  it('refreshes objective columns but preserves later qualitative + weather enrichment', async () => {
    await upsertRun(sampleRun());

    // Simulate a later pipeline enriching the row (voice note + Open-Meteo).
    await query(
      `UPDATE public.runs
         SET fueling = $2, perceived_effort = $3, general_notes = $4,
             temp_c = $5, weather_conditions = $6
       WHERE strava_activity_id = $1`,
      [
        TEST_ACTIVITY_ID,
        'half a Powerade at 6k',
        7,
        'legs felt heavy',
        24.5,
        'Clear',
      ],
    );

    // Re-run the backfill with a corrected distance — objective data changes.
    await upsertRun(
      sampleRun({ distance_km: 10.5, avg_pace_s_per_km: 285.71 }),
    );

    const { rows } = await query<{
      distance_km: string;
      fueling: string | null;
      perceived_effort: number | null;
      general_notes: string | null;
      temp_c: string | null;
      weather_conditions: string | null;
    }>(
      `SELECT distance_km, fueling, perceived_effort, general_notes,
              temp_c, weather_conditions
         FROM public.runs WHERE strava_activity_id = $1`,
      [TEST_ACTIVITY_ID],
    );
    const row = rows[0]!;
    expect(Number(row.distance_km)).toBe(10.5); // objective column updated
    expect(row.fueling).toBe('half a Powerade at 6k'); // enrichment preserved
    expect(row.perceived_effort).toBe(7);
    expect(row.general_notes).toBe('legs felt heavy');
    expect(Number(row.temp_c)).toBe(24.5);
    expect(row.weather_conditions).toBe('Clear');
  });
});

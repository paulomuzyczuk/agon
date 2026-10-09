import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRun } from '@/services/strava/ingest';
import { updateRunStartGps, updateRunHr } from '@/services/runs';
import {
  getGoogleHealthWatermark,
  syncNewGoogleHealthRuns,
} from '@/services/googleHealth/sync';
import type { RunRecord } from '@/lib/types';
import type { GoogleHealthBackfillOptions } from '@/services/googleHealth/ingest';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves what the unit suite can't: the (source, external_id) identity added by
// 20260724010000 actually keys the shared upsertRun (so Strava and Google Health
// runs sharing an external_id coexist), the google_health watermark reads only
// its own source, and updateRunStartGps seeds GPS without clobbering.

const EXT = 'gh-int-000111';
const OTHER_EXT = 'gh-int-000222';

function ghRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    date: '2026-08-01',
    started_at: '2026-08-01T09:00:00.000Z',
    start_lat: null,
    start_lng: null,
    block: 3,
    week: 19,
    distance_km: 10,
    duration_s: 3000,
    avg_hr: 150,
    max_hr: 170,
    avg_pace_s_per_km: 300,
    elevation_gain_m: 20,
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: null,
    external_id: EXT,
    source: 'google_health',
    origin: 'health_connect',
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
    ...over,
  };
}

beforeAll(() => loadEnv());

afterEach(async () => {
  await query(
    `DELETE FROM public.runs WHERE source = 'google_health' AND external_id = ANY($1)`,
    [[EXT, OTHER_EXT]],
  );
  await query(
    `DELETE FROM public.runs WHERE source = 'strava' AND external_id = $1`,
    [EXT],
  );
});

afterAll(() => closeDbPool());

describe('upsertRun for google_health (identity + idempotency)', () => {
  it('inserts then updates on re-run, never duplicating', async () => {
    expect((await upsertRun(ghRun())).status).toBe('inserted');
    expect((await upsertRun(ghRun())).status).toBe('updated');
    const { rows } = await query<{ count: string }>(
      `SELECT count(*) FROM public.runs
        WHERE source = 'google_health' AND external_id = $1`,
      [EXT],
    );
    expect(rows[0]!.count).toBe('1');
  });

  it('does NOT collide with a Strava run that shares the same external_id', async () => {
    await upsertRun(ghRun());
    // Same external_id string, different source → a distinct row (the whole point
    // of keying on the (source, external_id) pair).
    const strava = await upsertRun(
      ghRun({ source: 'strava', strava_activity_id: 424242 }),
    );
    expect(strava.status).toBe('inserted');
    const { rows } = await query<{ count: string }>(
      `SELECT count(*) FROM public.runs WHERE external_id = $1`,
      [EXT],
    );
    expect(rows[0]!.count).toBe('2'); // one per source
    await query(`DELETE FROM public.runs WHERE strava_activity_id = 424242`);
  });
});

describe('updateRunStartGps', () => {
  it('seeds start GPS and does not clobber an existing value', async () => {
    const { id } = await upsertRun(ghRun());
    await updateRunStartGps(id, 52.52, 13.405);
    let { rows } = await query<{ start_lat: string; start_lng: string }>(
      `SELECT start_lat, start_lng FROM public.runs WHERE id = $1`,
      [id],
    );
    expect(Number(rows[0]!.start_lat)).toBeCloseTo(52.52);
    expect(Number(rows[0]!.start_lng)).toBeCloseTo(13.405);
    // A later seed with different coords must NOT overwrite (COALESCE).
    await updateRunStartGps(id, 0, 0);
    ({ rows } = await query(
      `SELECT start_lat, start_lng FROM public.runs WHERE id = $1`,
      [id],
    ));
    expect(Number(rows[0]!.start_lat)).toBeCloseTo(52.52);
  });
});

describe('updateRunHr (fill without clobbering SOT HR)', () => {
  it('fills avg/max only where null — a chest-strap avg is preserved', async () => {
    // A run whose SOT record carried a chest-strap avg_hr but no max.
    const { id } = await upsertRun(ghRun({ avg_hr: 150, max_hr: null }));
    await updateRunHr(id, 148, 175); // Fitbit-wrist avg 148, max 175
    const { rows } = await query<{ avg_hr: number; max_hr: number }>(
      `SELECT avg_hr, max_hr FROM public.runs WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.avg_hr).toBe(150); // SOT avg kept, NOT overwritten
    expect(rows[0]!.max_hr).toBe(175); // max was null → filled from Fitbit
  });

  it('fills a run that had no HR at all', async () => {
    const { id } = await upsertRun(ghRun({ avg_hr: null, max_hr: null }));
    await updateRunHr(id, 142, 168);
    const { rows } = await query<{ avg_hr: number; max_hr: number }>(
      `SELECT avg_hr, max_hr FROM public.runs WHERE id = $1`,
      [id],
    );
    expect(rows[0]!.avg_hr).toBe(142);
    expect(rows[0]!.max_hr).toBe(168);
  });
});

describe('getGoogleHealthWatermark + syncNewGoogleHealthRuns (injected pull)', () => {
  it('reads the latest google_health started_at and feeds it as start_time', async () => {
    await upsertRun(ghRun({ started_at: '2026-08-01T09:00:00.000Z' }));
    await upsertRun(
      ghRun({
        external_id: OTHER_EXT,
        started_at: '2026-08-10T07:30:00.000Z',
      }),
    );

    const wm = await getGoogleHealthWatermark();
    expect(wm).toBeInstanceOf(Date);
    expect(wm!.getTime()).toBeGreaterThanOrEqual(
      new Date('2026-08-10T07:30:00.000Z').getTime(),
    );

    let seen: GoogleHealthBackfillOptions | undefined;
    const result = await syncNewGoogleHealthRuns(
      {},
      {
        getWatermark: getGoogleHealthWatermark, // real DB read
        runIncremental: async (opts) => {
          seen = opts;
          return {
            pagesFetched: 1,
            sessionsSeen: 0,
            runsInserted: 0,
            runsUpdated: 0,
            skippedNonRun: 0,
            runsDeduped: 0,
            runsSkippedExisting: 0,
            streamsFetched: 0,
            hrStreamsFetched: 0,
            rateLimited: false,
          };
        },
      },
    );
    expect(seen?.startTimeAfter).toBeDefined();
    expect(result.since).toBe(seen?.startTimeAfter);
  });
});

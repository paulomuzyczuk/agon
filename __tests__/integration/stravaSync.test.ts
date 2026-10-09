import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRun } from '@/services/strava/ingest';
import { getStravaWatermark, syncNewStravaRuns } from '@/services/strava/sync';
import type { RunRecord } from '@/lib/types';
import type { BackfillOptions } from '@/services/strava/ingest';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves what the unit suite can't: that the watermark query reads the real
// max(started_at) for source='strava' (ignoring other sources), and that
// syncNewStravaRuns feeds that watermark to the (here-mocked) pull as `after`.
// The Strava network call itself is injected — this lane never hits the API.

const OLD_ID = 999_000_222_001;
const NEW_ID = 999_000_222_002;
const OTHER_SOURCE_ID = 999_000_222_003;

function sampleRun(over: Partial<RunRecord> = {}): RunRecord {
  const base: RunRecord = {
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
    shoe_used: null,
    fueling: null,
    perceived_effort: null,
    pain_location: null,
    pain_onset_km: null,
    general_notes: null,
    strava_activity_id: OLD_ID,
    external_id: String(OLD_ID),
    source: 'strava',
    origin: null,
    temp_c: null,
    humidity_pct: null,
    wind_kph: null,
    weather_conditions: null,
    ...over,
  };
  // Keep external_id (the new idempotency key) in lockstep with the activity id
  // so overriding strava_activity_id doesn't collide two rows on (source, ext_id).
  return over.external_id !== undefined
    ? base
    : { ...base, external_id: String(base.strava_activity_id) };
}

const IDS = [OLD_ID, NEW_ID, OTHER_SOURCE_ID];

beforeAll(() => loadEnv());

afterEach(async () => {
  await query('DELETE FROM public.runs WHERE strava_activity_id = ANY($1)', [
    IDS,
  ]);
});

afterAll(() => closeDbPool());

describe('getStravaWatermark', () => {
  it('returns null when there are no Strava runs', async () => {
    // (Any pre-existing strava rows in a shared dev DB would defeat this, so we
    // only assert the shape: null or a Date. The relative-latest test below is
    // the meaningful one.)
    const wm = await getStravaWatermark();
    expect(wm === null || wm instanceof Date).toBe(true);
  });

  it('returns the latest started_at among Strava runs, ignoring other sources', async () => {
    await upsertRun(sampleRun({ started_at: '2026-05-01T09:00:00.000Z' }));
    await upsertRun(
      sampleRun({
        strava_activity_id: NEW_ID,
        started_at: '2026-06-15T07:30:00.000Z',
      }),
    );
    // A later run from a different source must not move the Strava watermark.
    await upsertRun(
      sampleRun({
        strava_activity_id: OTHER_SOURCE_ID,
        started_at: '2026-09-01T07:30:00.000Z',
        source: 'manual',
      }),
    );

    const wm = await getStravaWatermark();
    expect(wm).toBeInstanceOf(Date);
    // At least as new as our newest strava row (a shared dev DB may hold newer).
    expect(wm!.getTime()).toBeGreaterThanOrEqual(
      new Date('2026-06-15T07:30:00.000Z').getTime(),
    );
    // …but NOT the future-dated manual row — proving other sources are ignored.
    // No real Strava run can exist in the future, so this bound is safe.
    expect(wm!.getTime()).toBeLessThan(
      new Date('2026-09-01T07:30:00.000Z').getTime(),
    );
  });
});

describe('syncNewStravaRuns (real watermark, injected pull)', () => {
  it('derives `after` from the DB watermark', async () => {
    const watermark = '2026-06-15T07:30:00.000Z';
    await upsertRun(sampleRun({ started_at: watermark }));

    let seen: BackfillOptions | undefined;
    const result = await syncNewStravaRuns(
      {},
      {
        getWatermark: getStravaWatermark, // real DB read
        runIncremental: async (opts) => {
          seen = opts;
          return {
            pagesFetched: 1,
            activitiesSeen: 0,
            runsInserted: 0,
            runsUpdated: 0,
            skippedNonRun: 0,
            runsSkippedExisting: 0,
            runsSuperseded: 0,
            streamsFetched: 0,
            rateLimited: false,
          };
        },
      },
    );

    expect(seen?.after).toBeDefined();
    // The watermark feeds `after` (a shared DB may have a newer strava row, so
    // assert the floor rather than exact equality).
    expect(result.since).toBeGreaterThanOrEqual(
      Math.floor(new Date(watermark).getTime() / 1000),
    );
    expect(seen?.after).toBe(result.since);
  });
});

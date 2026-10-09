import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertGear, resolveLocalGear, linkRunGear } from '@/services/gear';
import { localGearId, hrmForDate } from '@/lib/gear';
import { upsertRun } from '@/services/strava/ingest';
import type { RunRecord } from '@/lib/types';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves the categorized-gear model against a real engine: Strava gear upserts
// idempotently, a name-only item mints exactly one local id, and a run links to
// multiple gear items (shoe + HRM) through run_gear.

const STRAVA_GEAR_ID = 'g_test_999';
const LOCAL_SHOE = 'Test Vaporfly 3';
const RUN_ID = 999_000_111_333;

async function cleanup(): Promise<void> {
  // run_gear rows cascade from runs; then remove the test gear.
  await query('DELETE FROM public.runs WHERE strava_activity_id = $1', [
    RUN_ID,
  ]);
  await query('DELETE FROM public.gear WHERE gear_id = ANY($1)', [
    [STRAVA_GEAR_ID, localGearId(LOCAL_SHOE), 'local:polar-h9'],
  ]);
}

function sampleRun(date: string): RunRecord {
  return {
    date,
    started_at: `${date}T09:00:00.000Z`,
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
    shoe_used: LOCAL_SHOE,
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

async function gearIdsForRun(): Promise<string[]> {
  const { rows } = await query<{ gear_id: string }>(
    `SELECT rg.gear_id
       FROM public.run_gear rg
       JOIN public.runs r ON r.id = rg.run_id
      WHERE r.strava_activity_id = $1
      ORDER BY rg.gear_id`,
    [RUN_ID],
  );
  return rows.map((r) => r.gear_id);
}

beforeAll(() => loadEnv());
beforeEach(cleanup);
afterEach(cleanup);
afterAll(() => closeDbPool());

describe('gear catalog', () => {
  it('upserts Strava gear idempotently on its own id', async () => {
    await upsertGear({
      gear_id: STRAVA_GEAR_ID,
      name: 'Vaporfly',
      source: 'strava',
      category: 'shoe',
    });
    await upsertGear({
      gear_id: STRAVA_GEAR_ID,
      name: 'Vaporfly 3',
      source: 'strava',
      category: 'shoe',
    });
    const { rows } = await query<{ name: string; category: string }>(
      'SELECT name, category FROM public.gear WHERE gear_id = $1',
      [STRAVA_GEAR_ID],
    );
    expect(rows).toHaveLength(1); // one row — updated, not duplicated
    expect(rows[0]!.name).toBe('Vaporfly 3');
    expect(rows[0]!.category).toBe('shoe');
  });

  it('mints exactly one local id for a name-only item, and reuses it', async () => {
    const first = await resolveLocalGear(LOCAL_SHOE, 'shoe');
    const second = await resolveLocalGear(LOCAL_SHOE.toUpperCase(), 'shoe');
    expect(first).toBe(localGearId(LOCAL_SHOE));
    expect(second).toBe(first);
    const { rows } = await query<{ count: string }>(
      'SELECT count(*) FROM public.gear WHERE gear_id = $1',
      [first],
    );
    expect(rows[0]!.count).toBe('1');
  });
});

describe('run_gear linking', () => {
  it('links a run to both a shoe and its date-appropriate HRM', async () => {
    const date = '2026-05-01'; // Polar H9 era
    const { id } = await upsertRun(sampleRun(date));

    const shoeId = await resolveLocalGear(LOCAL_SHOE, 'shoe');
    await linkRunGear(id, shoeId);

    const hrm = hrmForDate(date)!;
    expect(hrm.gear_id).toBe('local:polar-h9');
    await upsertGear({
      gear_id: hrm.gear_id,
      name: hrm.name,
      brand: hrm.brand,
      source: 'local',
      category: 'hrm',
    });
    await linkRunGear(id, hrm.gear_id);

    expect(await gearIdsForRun()).toEqual([shoeId, 'local:polar-h9'].sort());

    // Linking again is idempotent — still two rows.
    await linkRunGear(id, shoeId);
    expect(await gearIdsForRun()).toHaveLength(2);
  });
});

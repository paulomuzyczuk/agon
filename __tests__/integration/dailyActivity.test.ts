import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  upsertDailyActivity,
  type DailyActivityRecord,
} from '@/services/dailyActivity';

// Integration lane — requires a live local Postgres with migrations applied.
// Proves the daily_activity upsert is idempotent on (date, source).

const DATE = '2026-07-15';

function record(
  overrides: Partial<DailyActivityRecord> = {},
): DailyActivityRecord {
  return {
    date: DATE,
    source: 'fitbit',
    steps: 8000,
    distanceKm: 6.2,
    floors: 10,
    activeMinutes: 55,
    sedentaryMinutes: 600,
    caloriesOut: 2600,
    restingHr: 60,
    ...overrides,
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.daily_activity WHERE date = $1', [DATE]);
});
afterAll(() => closeDbPool());

describe('daily_activity storage', () => {
  it('upserts idempotently on (date, source) and updates in place', async () => {
    await upsertDailyActivity(record());
    await upsertDailyActivity(record({ steps: 12345 })); // same day+source

    const { rows } = await query<{ steps: number; count: string }>(
      `SELECT steps, count(*) OVER () AS count
         FROM public.daily_activity WHERE date = $1 AND source = 'fitbit'`,
      [DATE],
    );
    expect(rows).toHaveLength(1); // one row — updated, not duplicated
    expect(rows[0]!.steps).toBe(12345);
  });

  it('allows a different source for the same day', async () => {
    await upsertDailyActivity(record());
    await upsertDailyActivity(record({ source: 'manual', steps: 1 }));
    const { rows } = await query<{ count: string }>(
      'SELECT count(*) FROM public.daily_activity WHERE date = $1',
      [DATE],
    );
    expect(rows[0]!.count).toBe('2');
  });
});

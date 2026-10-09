import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  upsertSleepSession,
  upsertHrvDaily,
  type SleepSessionRecord,
} from '@/services/wellness';

// Integration lane — requires a live local Postgres with migrations applied.
// Proves sleep + HRV upserts are idempotent on their conflict keys.

const LOG_ID = 987_654;
const DATE = '2026-08-02';

function sleep(
  overrides: Partial<SleepSessionRecord> = {},
): SleepSessionRecord {
  return {
    date: DATE,
    source: 'fitbit',
    externalId: String(LOG_ID),
    logId: LOG_ID,
    startAt: '2026-08-02T02:30:00.000Z',
    endAt: '2026-08-02T10:00:00.000Z',
    isMainSleep: true,
    minutesAsleep: 410,
    minutesAwake: 40,
    timeInBed: 450,
    efficiency: 92,
    deepMin: 80,
    lightMin: 230,
    remMin: 100,
    wakeMin: 40,
    ...overrides,
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.sleep_sessions WHERE log_id = $1', [LOG_ID]);
  await query('DELETE FROM public.hrv_daily WHERE date = $1', [DATE]);
});
afterAll(() => closeDbPool());

describe('wellness storage', () => {
  it('upserts a sleep session idempotently on (source, external_id)', async () => {
    await upsertSleepSession(sleep());
    await upsertSleepSession(sleep({ efficiency: 95 })); // same log

    const { rows } = await query<{ efficiency: number; count: string }>(
      `SELECT efficiency, count(*) OVER () AS count
         FROM public.sleep_sessions WHERE log_id = $1`,
      [LOG_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.efficiency).toBe(95);
  });

  it('upserts HRV idempotently on (date, source)', async () => {
    await upsertHrvDaily({
      date: DATE,
      source: 'fitbit',
      dailyRmssd: 42,
      deepRmssd: 55,
    });
    await upsertHrvDaily({
      date: DATE,
      source: 'fitbit',
      dailyRmssd: 44,
      deepRmssd: 57,
    });
    const { rows } = await query<{ daily_rmssd: string; count: string }>(
      `SELECT daily_rmssd, count(*) OVER () AS count
         FROM public.hrv_daily WHERE date = $1 AND source = 'fitbit'`,
      [DATE],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.daily_rmssd)).toBe(44);
  });
});

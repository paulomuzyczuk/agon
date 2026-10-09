import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { recordSweatObservation, getBaselineSweatRate } from '@/services/sweat';

// Integration lane — sweat observation storage + baseline read against a live DB.

const DATE = '2099-01-05'; // far future so it's the latest observation for the baseline read
const RUN_DATE = '2099-01-06';

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.sweat_observations WHERE date = ANY($1)', [
    [DATE, RUN_DATE],
  ]);
  await query('DELETE FROM public.runs WHERE date = ANY($1)', [
    [DATE, RUN_DATE],
  ]);
});
afterAll(() => closeDbPool());

describe('recordSweatObservation', () => {
  it('attributes to the latest run on the date and derives the rate', async () => {
    await query(
      `INSERT INTO public.runs (date, distance_km, duration_s, source)
       VALUES ($1, 15, 3600, 'strava')`,
      [RUN_DATE],
    );
    const result = await recordSweatObservation({
      date: RUN_DATE,
      preKg: 76.4,
      postKg: 75.8,
      fluidL: 0.5,
    });
    expect(result.sweatRateLPerH).toBe(1.1);
    expect(result.runId).not.toBeNull();
    expect(result.durationS).toBe(3600);
  });

  it('stores a null rate when there is no run to divide by', async () => {
    const result = await recordSweatObservation({
      date: DATE,
      preKg: 76,
      postKg: 75,
      fluidL: 0,
    });
    expect(result.sweatRateLPerH).toBeNull();
    expect(result.runId).toBeNull();
  });
});

describe('getBaselineSweatRate', () => {
  it('returns the most recent observation that produced a rate', async () => {
    await query(
      `INSERT INTO public.runs (date, distance_km, duration_s, source)
       VALUES ($1, 15, 3600, 'strava')`,
      [RUN_DATE],
    );
    await recordSweatObservation({
      date: RUN_DATE,
      preKg: 77,
      postKg: 76.2,
      fluidL: 0,
    });
    // 0.8 kg lost over 1 h → 0.8 L/h
    expect(await getBaselineSweatRate()).toBe(0.8);
  });
});

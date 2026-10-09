import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  insertRideFuelingItem,
  upsertFuelingProduct,
} from '@/services/fueling';
import {
  loadFuelingCandidates,
  upsertFuelingBalance,
} from '@/services/fuelingBalance';
import { computeFuelingBalance } from '@/lib/fuelingModel';

// Integration lane — ride fueling items + the fueling-balance load/upsert path
// (MZY-64) against a live DB. Far-future dates keep test rows out of real data.

const RIDE_DATE = '2099-02-01';
const SHORT_DATE = '2099-02-02';
const WEIGH_DATE = '2099-01-31';
const PRODUCT = 'IntegBottle';

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.rides WHERE date = ANY($1)', [
    [RIDE_DATE, SHORT_DATE],
  ]);
  await query('DELETE FROM public.runs WHERE date = ANY($1)', [[SHORT_DATE]]);
  await query('DELETE FROM public.body_metrics WHERE date = $1', [WEIGH_DATE]);
  await query('DELETE FROM public.fueling_products WHERE name = $1', [PRODUCT]);
});
afterAll(() => closeDbPool());

async function insertRide(date: string, durationS: number): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.rides
       (date, distance_km, duration_s, avg_hr, temp_c, humidity_pct, source, external_id)
     VALUES ($1, 60, $2, 140, 25, 60, 'manual', $3)
     RETURNING id`,
    [date, durationS, `integ-${date}`],
  );
  return rows[0]!.id;
}

describe('fueling balance', () => {
  it('sums ride intake, picks the latest weigh-in, and upserts idempotently', async () => {
    await upsertFuelingProduct({
      name: PRODUCT,
      category: 'isotonic',
      servingDesc: '500 ml',
      waterMl: 500,
      carbsG: 30,
      sodiumMg: 300,
      potassiumMg: 0,
      magnesiumMg: 0,
      caffeineMg: 0,
      kcal: 120,
    });
    const { rows: p } = await query<{ id: string }>(
      'SELECT id FROM public.fueling_products WHERE name = $1',
      [PRODUCT],
    );
    const rideId = await insertRide(RIDE_DATE, 3 * 3600);
    await insertRideFuelingItem({
      rideId,
      productId: p[0]!.id,
      quantity: 3,
      timingKm: null,
      notes: null,
    });
    await query(
      `INSERT INTO public.body_metrics (date, weight_kg) VALUES ($1, 78.5)`,
      [WEIGH_DATE],
    );

    const candidates = await loadFuelingCandidates('ride');
    const c = candidates.find((x) => x.id === rideId)!;
    expect(c.intake).toEqual({ waterMl: 1500, carbsG: 90, sodiumMg: 900 });
    expect(c.bodyMassKg).toBe(78.5);

    const balance = computeFuelingBalance({
      durationS: c.durationS,
      avgHr: c.avgHr,
      hrRest: 50,
      hrMax: 190,
      tempC: c.tempC,
      humidityPct: c.humidityPct,
      baselineSweatRateLPerH: 0.8,
      sweatSodiumMgPerL: 950,
      bodyMassKg: c.bodyMassKg!,
      intake: c.intake,
    });
    const row = {
      id: rideId,
      durationS: c.durationS,
      avgHr: c.avgHr,
      baselineSweatRateLPerH: 0.8,
      sweatSodiumMgPerL: 950,
      bodyMassKg: c.bodyMassKg!,
      balance,
    };
    await upsertFuelingBalance('ride', row);
    await upsertFuelingBalance('ride', row); // recompute overwrites, no dup

    const { rows } = await query<{
      n: string;
      carbs_per_h: string;
      under_fueled: boolean;
      intake_logged: boolean;
    }>(
      `SELECT count(*) OVER () AS n, carbs_per_h, under_fueled, intake_logged
         FROM public.ride_fueling_balance WHERE ride_id = $1`,
      [rideId],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.carbs_per_h)).toBe(30); // 90 g over 3 h
    expect(rows[0]!.under_fueled).toBe(true); // >2.5 h wants ≥60 g/h
    expect(rows[0]!.intake_logged).toBe(true);
  });

  it('skips short activities with no logged intake', async () => {
    const rideId = await insertRide(SHORT_DATE, 1800);
    const { rows: r } = await query<{ id: string }>(
      `INSERT INTO public.runs (date, distance_km, duration_s, source)
       VALUES ($1, 5, 1800, 'manual') RETURNING id`,
      [SHORT_DATE],
    );
    expect(
      (await loadFuelingCandidates('ride')).map((x) => x.id),
    ).not.toContain(rideId);
    expect((await loadFuelingCandidates('run')).map((x) => x.id)).not.toContain(
      r[0]!.id,
    );
  });
});

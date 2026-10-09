import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  upsertFuelingProduct,
  findFuelingProductByName,
} from '@/services/fueling';
import type { FuelingProductSpec } from '@/lib/fuelingCatalog';

// Integration lane — the fueling catalog upsert + case-insensitive name resolver.

const NAME = 'IntegGel';

function product(
  overrides: Partial<FuelingProductSpec> = {},
): FuelingProductSpec {
  return {
    name: NAME,
    category: 'gel',
    servingDesc: '1 sachet',
    waterMl: 0,
    carbsG: 22,
    sodiumMg: 60,
    potassiumMg: 40,
    magnesiumMg: 0,
    caffeineMg: 20,
    kcal: 100,
    notes: null,
    ...overrides,
  };
}

beforeAll(() => loadEnv());
afterEach(async () => {
  await query('DELETE FROM public.fueling_products WHERE name = $1', [NAME]);
});
afterAll(() => closeDbPool());

describe('fueling catalog', () => {
  it('upserts idempotently on name and updates facts', async () => {
    await upsertFuelingProduct(product({ carbsG: 22 }));
    await upsertFuelingProduct(product({ carbsG: 25 })); // same name → update
    const { rows } = await query<{ carbs_g: string; count: string }>(
      `SELECT carbs_g, count(*) OVER () AS count
         FROM public.fueling_products WHERE name = $1`,
      [NAME],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.carbs_g)).toBe(25);
  });

  it('resolves a spoken name case-insensitively', async () => {
    await upsertFuelingProduct(product());
    const match = await findFuelingProductByName('inteGGEL');
    expect(match?.name).toBe(NAME);
  });

  it('returns null for an unknown product', async () => {
    expect(await findFuelingProductByName('NoSuchThing')).toBeNull();
  });
});

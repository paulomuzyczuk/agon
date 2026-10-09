import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { applyMutations, rowMutations } from '@/services/sync/apply';
import { pullChanges } from '@/services/sync/pull';
import {
  restoreDeviceExport,
  type DeviceExport,
} from '@/services/sync/restore';
import { applyPulled, type ReplicaTables } from '@/lib/sync/replicaState';

// Integration lane (agon_test). MZY-207 acceptance: "a script that rebuilds
// Postgres's athlete-authored tables from a device export". Build the export
// exactly as a device holds it (full pull → replica), lose the rows on the
// server, restore, compare.

const DAY = '2026-08-30';
const FOOD = 'zz-restore-food';

async function deviceExport(): Promise<DeviceExport> {
  const tables: ReplicaTables = {};
  let since = 0;
  for (;;) {
    const page = await pullChanges(since, 1000);
    applyPulled(tables, page.changes, page.aliases);
    since = page.cursor;
    if (!page.hasMore) break;
  }
  return {
    format: 'agon-replica-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: Object.fromEntries(
      Object.entries(tables).map(([t, rows]) => [t, [...rows.values()]]),
    ),
  };
}

async function snapshot(mealIds: string[]) {
  const { rows } = await query(
    `SELECT ml.id, ml.meal_slot, ml.notes, ml.field_hlc, ml.deleted_at, mli.quantity::float AS q, mli.field_hlc AS item_hlc
       FROM public.meal_logs ml JOIN public.meal_log_items mli ON mli.meal_log_id = ml.id
      WHERE ml.id = ANY($1::uuid[]) ORDER BY ml.id`,
    [mealIds],
  );
  return rows;
}

async function cleanup() {
  await query(`DELETE FROM public.meal_logs WHERE date = $1`, [DAY]);
  await query(`DELETE FROM public.foods WHERE name = $1`, [FOOD]);
  await query(`DELETE FROM public.medications WHERE name = 'zz-restore-med'`);
}

beforeAll(async () => {
  loadEnv();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await closeDbPool();
});

it('rebuilds lost rows with their original values and stamps; re-running is a no-op; newer server data wins', async () => {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.foods (name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal)
     VALUES ($1, 50, 'g', 30, 5, 2, 160) RETURNING id`,
    [FOOD],
  );
  const food = rows[0]!.id;
  const meals = [crypto.randomUUID(), crypto.randomUUID()];
  const med = crypto.randomUUID();
  await applyMutations(
    [
      ...rowMutations(
        'meal_logs',
        meals[0]!,
        { date: DAY, meal_slot: 'lunch', source: 'manual', notes: 'kept' },
        'human',
        'phone',
      ),
      ...rowMutations(
        'meal_log_items',
        crypto.randomUUID(),
        { meal_log_id: meals[0], food_id: food, quantity: 1.5 },
        'human',
        'phone',
      ),
      ...rowMutations(
        'meal_logs',
        meals[1]!,
        { date: DAY, meal_slot: 'dinner', source: 'manual' },
        'human',
        'phone',
      ),
      ...rowMutations(
        'meal_log_items',
        crypto.randomUUID(),
        { meal_log_id: meals[1], food_id: food, quantity: 2 },
        'human',
        'phone',
      ),
      ...rowMutations(
        'medications',
        med,
        { name: 'zz-restore-med', kind: 'supplement', active: true },
        'human',
        'phone',
      ),
    ],
    { serverWriter: true },
  );
  await applyMutations(
    rowMutations(
      'meal_logs',
      meals[1]!,
      { deleted_at: new Date().toISOString() },
      'human',
      'phone',
    ),
    { serverWriter: true },
  );

  const before = await snapshot(meals);
  const exp = await deviceExport();

  // The server loses them (as on 2026-09-08).
  await query(`DELETE FROM public.meal_logs WHERE id = ANY($1::uuid[])`, [
    meals,
  ]);
  await query(`DELETE FROM public.medications WHERE id = $1`, [med]);
  expect(await snapshot(meals)).toEqual([]);

  const first = await restoreDeviceExport(exp);
  expect(first.rejected).toEqual([]);
  expect(await snapshot(meals)).toEqual(before); // values, tombstone and per-field stamps
  const { rows: medRows } = await query(
    'SELECT name FROM public.medications WHERE id = $1',
    [med],
  );
  expect(medRows).toEqual([{ name: 'zz-restore-med' }]);

  const again = await restoreDeviceExport(exp);
  expect(again.applied).toBe(0);

  // An edit made on the server after the export is not rolled back by it.
  await applyMutations(
    rowMutations('meal_logs', meals[0]!, { notes: 'newer' }, 'human', 'laptop'),
    { serverWriter: true },
  );
  await restoreDeviceExport(exp);
  const { rows: after } = await query(
    'SELECT notes FROM public.meal_logs WHERE id = $1',
    [meals[0]],
  );
  expect(after).toEqual([{ notes: 'newer' }]);
});

import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { applyMutations, rowMutations } from '@/services/sync/apply';
import { pullChanges } from '@/services/sync/pull';
import { getHealthSummary, getLabTrends } from '@/services/marts/health';
import {
  getDailyNutritionTotals,
  listMealLogsForDate,
} from '@/services/mealLogs';
import { applyPulled, type ReplicaTables } from '@/lib/sync/replicaState';
import { healthView, labTrendsView, mealLogsView } from '@/lib/sync/views';

// Integration lane (agon_test). MZY-207: offline pages render from the device
// replica through lib/sync/views.ts, online pages from the server. This pins
// the two to the SAME output for the same data — pull everything into an
// in-memory replica and compare against the server read models.

const DAY = '2026-09-20';
const FOOD = 'zz-parity-food';
const uid = () => crypto.randomUUID();

async function human(
  table: Parameters<typeof rowMutations>[0],
  values: Record<string, unknown>,
) {
  const id = uid();
  const res = await applyMutations(
    rowMutations(table, id, values, 'human', 'parity'),
    { serverWriter: true },
  );
  expect(res.every((r) => r.status === 'applied')).toBe(true);
  return id;
}

async function cleanup() {
  await query(`DELETE FROM public.meal_logs WHERE date = $1`, [DAY]);
  await query(`DELETE FROM public.foods WHERE name = $1`, [FOOD]);
  await query(
    `DELETE FROM public.lab_panels WHERE panel_type LIKE 'zz-parity%'`,
  );
  await query(
    `DELETE FROM public.routine_logs WHERE routine_id IN (SELECT id FROM public.routines WHERE name LIKE 'zz-parity%')`,
  );
  await query(`DELETE FROM public.routines WHERE name LIKE 'zz-parity%'`);
  await query(`DELETE FROM public.medications WHERE name LIKE 'zz-parity%'`);
  await query(`DELETE FROM public.injuries WHERE body_part LIKE 'zz-parity%'`);
  await query(
    `DELETE FROM public.medical_visits WHERE visit_type LIKE 'zz-parity%'`,
  );
  await query(
    `DELETE FROM public.vaccinations WHERE vaccine LIKE 'zz-parity%'`,
  );
  await query(
    `DELETE FROM public.health_conditions WHERE name LIKE 'zz-parity%'`,
  );
}

async function replica(): Promise<ReplicaTables> {
  const tables: ReplicaTables = {};
  let since = 0;
  for (;;) {
    const page = await pullChanges(since, 1000);
    applyPulled(tables, page.changes, page.aliases);
    since = page.cursor;
    if (!page.hasMore) return tables;
  }
}

beforeAll(async () => {
  loadEnv();
  await cleanup();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.foods (name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal)
     VALUES ($1, 33, 'g', 21.7, 4.3, 2.1, 123.4) RETURNING id`,
    [FOOD],
  );
  const food = rows[0]!.id;
  const today = new Date().toISOString().slice(0, 10);

  const m1 = await human('meal_logs', {
    date: DAY,
    meal_slot: 'breakfast',
    source: 'manual',
    notes: 'with honey',
  });
  await human('meal_log_items', {
    meal_log_id: m1,
    food_id: food,
    quantity: 1.3,
  });
  await human('meal_log_items', {
    meal_log_id: m1,
    food_id: food,
    quantity: 0.7,
  });
  const m2 = await human('meal_logs', {
    date: DAY,
    meal_slot: 'dinner',
    source: 'manual',
  });
  await human('meal_log_items', {
    meal_log_id: m2,
    food_id: food,
    quantity: 2.35,
  });
  const gone = await human('meal_logs', {
    date: DAY,
    meal_slot: 'snack',
    source: 'manual',
  });
  await human('meal_log_items', {
    meal_log_id: gone,
    food_id: food,
    quantity: 5,
  });
  await applyMutations(
    rowMutations(
      'meal_logs',
      gone,
      { deleted_at: new Date().toISOString() },
      'human',
      'parity',
    ),
    { serverWriter: true },
  );

  const panel = await human('lab_panels', {
    date: '2026-09-01',
    panel_type: 'zz-parity-blood',
    lab_name: 'Lab A',
  });
  await human('lab_panel_results', {
    lab_panel_id: panel,
    marker: 'ferritin',
    value_numeric: 88.5,
    unit: 'ug/L',
    reference_low: 30,
    reference_high: 400,
    flag: 'normal',
  });
  await human('lab_panel_results', {
    lab_panel_id: panel,
    marker: 'blood type',
    value_text: 'A+',
  });

  const routine = await human('routines', {
    name: 'zz-parity PM',
    routine_type: 'skincare',
    time_of_day: 'pm',
  });
  await human('routine_steps', {
    routine_id: routine,
    step_order: 1,
    product: 'retinol',
  });
  await human('routine_steps', {
    routine_id: routine,
    step_order: 0,
    product: 'cleanser',
  });
  await human('routine_logs', {
    date: today,
    routine_id: routine,
    completed: true,
  });

  await human('medications', {
    name: 'zz-parity mag',
    kind: 'supplement',
    dosage: '200 mg',
    active: true,
  });
  await human('medications', {
    name: 'zz-parity old',
    kind: 'medication',
    active: false,
  });
  await human('injuries', {
    onset_date: '2026-09-10',
    body_part: 'zz-parity calf',
    severity: 4,
  });
  await human('medical_visits', {
    date: '2026-09-11',
    visit_type: 'zz-parity physio',
    follow_up_date: '2026-10-01',
  });
  await human('vaccinations', {
    date: '2026-01-05',
    vaccine: 'zz-parity tetanus',
    dose_number: 2,
    next_due_date: '2036-01-05',
  });
  await human('health_conditions', {
    condition_type: 'allergy',
    name: 'zz-parity pollen',
    severity: 'mild',
  });
});

afterAll(async () => {
  await cleanup();
  await closeDbPool();
});

describe('offline views match the server read models (MZY-207)', () => {
  it('general health', async () => {
    const tables = await replica();
    const today = new Date().toISOString().slice(0, 10);
    // Result order within a panel is unspecified server-side; compare sorted.
    const norm = (h: Awaited<ReturnType<typeof getHealthSummary>>) => ({
      ...h,
      recentLabPanels: h.recentLabPanels.map((p) => ({
        ...p,
        results: [...p.results].sort((a, b) =>
          a.marker.localeCompare(b.marker),
        ),
      })),
    });
    expect(norm(healthView(tables, today))).toEqual(
      norm(await getHealthSummary()),
    );
  });

  it('lab trends', async () => {
    expect(labTrendsView(await replica())).toEqual(await getLabTrends());
  });

  it('a day of meals, with totals (tombstoned meal excluded)', async () => {
    const tables = await replica();
    const { rows: foods } = await query<{
      id: string;
      name: string;
      kcal: string;
      protein_g: string;
      carbs_g: string;
      fat_g: string;
    }>('SELECT id, name, kcal, protein_g, carbs_g, fat_g FROM public.foods');
    const view = mealLogsView(
      tables,
      DAY,
      foods.map((f) => ({
        id: f.id,
        name: f.name,
        kcal: Number(f.kcal),
        proteinG: Number(f.protein_g),
        carbsG: Number(f.carbs_g),
        fatG: Number(f.fat_g),
      })),
      new Map(),
    );
    const server = await listMealLogsForDate(DAY);
    // Item order within a meal is unspecified server-side; compare as sets.
    const norm = (logs: { id: string; items: { id: string }[] }[]) =>
      logs.map((l) => ({
        ...l,
        items: [...l.items].sort((a, b) => a.id.localeCompare(b.id)),
      }));
    expect(norm(view.todaysMealLogs)).toEqual(norm(server));
    const t = await getDailyNutritionTotals(DAY);
    expect(view.loggedTotals).toEqual({
      kcal: Math.round(t.kcal),
      proteinG: Math.round(t.proteinG),
      carbsG: Math.round(t.carbsG),
      fatG: Math.round(t.fatG),
    });
    expect(view.todaysMealLogs).toHaveLength(2);
  });
});

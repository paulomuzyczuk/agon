import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { POST as push } from '@/app/api/sync/push/route';
import { GET as pull } from '@/app/api/sync/pull/route';
import { applyMutations, rowMutations } from '@/services/sync/apply';
import { formatHlc } from '@/lib/sync/hlc';
import { SYNC_TABLES, SYNC_TABLE_NAMES } from '@/lib/sync/schema';
import {
  deleteMealLog,
  getDailyNutritionTotals,
  listMealLogsForDate,
  logAdHocMeal,
} from '@/services/mealLogs';
import { nutritionSummary } from '@/services/mcp/curatedNutrition';
import { closeReadPool } from '@/services/mcp/readonlyDb';
import { findOrCreateLabPanel, upsertLabResult } from '@/services/labResults';

// Integration lane (agon_test — jest.integration.setup.ts). MZY-206: the
// field-level push/pull against real Postgres — merge outcomes, idempotency,
// tombstones, natural-key aliasing, the whitelist, and the trigger that
// keeps legacy writers stamped.

const FOOD = 'zz-sync-test-rice';
const MED = 'zz-sync-test-med';
// In the past, like real edits: stamps ahead of the server clock are clamped
// (clampHlc), which would make these tests' fixed offsets meaningless.
const T = Math.floor(Date.now() / 1000) * 1000 - 86_400_000;
let foodId: string;

const hlc = (msAfter: number, node: string, counter = 0) =>
  formatHlc({ wall: T + msAfter, counter, node });

type M = {
  table: string;
  id: string;
  field: string;
  value: unknown;
  hlc: string;
  origin: 'human' | 'machine';
};
const human = (
  table: string,
  id: string,
  fields: Record<string, unknown>,
  stamp: string,
): M[] =>
  Object.entries(fields).map(([field, value]) => ({
    table,
    id,
    field,
    value,
    hlc: stamp,
    origin: 'human',
  }));

async function pushBatch(
  mutations: M[],
): Promise<{ status: string; error?: string; canonicalId?: string }[]> {
  const res = await push(
    new Request('http://localhost/api/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mutations }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: { status: string }[] }).results;
}

async function pullSince(since: number) {
  const res = await pull(
    new Request(`http://localhost/api/sync/pull?since=${since}`),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    changes: { table: string; seq: number; row: Record<string, unknown> }[];
    aliases: { aliasId: string; table: string; canonicalId: string }[];
    cursor: number;
    hasMore: boolean;
  };
}

async function mealRow(id: string) {
  const { rows } = await query<{
    meal_slot: string;
    notes: string | null;
    deleted_at: Date | null;
    created_at: Date;
  }>(
    'SELECT meal_slot, notes, deleted_at, created_at FROM public.meal_logs WHERE id = $1',
    [id],
  );
  return rows[0];
}

const newMeal = (id: string, stamp: string) =>
  human(
    'meal_logs',
    id,
    {
      date: '2026-09-25',
      meal_slot: 'breakfast',
      notes: null,
      deleted_at: null,
    },
    stamp,
  );

async function cleanup() {
  await query(
    `DELETE FROM public.meal_logs WHERE id IN (
       SELECT meal_log_id FROM public.meal_log_items mli JOIN public.foods f ON f.id = mli.food_id WHERE f.name = $1)
       OR notes LIKE 'zz-sync%'`,
    [FOOD],
  );
  await query(
    `DELETE FROM public.meal_logs WHERE date = '2026-09-25' AND source = 'manual'`,
  );
  await query(`DELETE FROM public.foods WHERE name = $1`, [FOOD]);
  await query(
    `DELETE FROM public.medication_logs WHERE medication_id IN (SELECT id FROM public.medications WHERE name = $1)`,
    [MED],
  );
  await query(`DELETE FROM public.medications WHERE name = $1`, [MED]);
  await query(
    `DELETE FROM public.lab_panels WHERE panel_type = 'zz-sync-panel'`,
  );
  await query(
    `DELETE FROM public.sync_id_aliases WHERE table_name IN ('medications','lab_panel_results')`,
  );
}

beforeAll(async () => {
  loadEnv();
  await cleanup();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.foods (name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal)
     VALUES ($1, 100, 'g', 28, 3, 0, 130) RETURNING id`,
    [FOOD],
  );
  foodId = rows[0]!.id;
});

afterAll(async () => {
  await cleanup();
  await closeDbPool();
  await closeReadPool();
});

describe('schema whitelist matches the database', () => {
  it('every syncable field exists as a column, and every table has the sync columns', async () => {
    for (const t of SYNC_TABLE_NAMES) {
      const { rows } = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [t],
      );
      const cols = new Set(rows.map((r) => r.column_name));
      for (const f of [
        ...Object.keys(SYNC_TABLES[t].fields),
        'sync_seq',
        'field_hlc',
        'edit_origin',
      ]) {
        expect(`${t}.${f}:${cols.has(f)}`).toBe(`${t}.${f}:true`);
      }
    }
  });
});

describe('push: create, replay, pull', () => {
  it('creates a meal + item, is idempotent on replay, and pull returns both in seq order', async () => {
    const before = (await pullSince(0)).cursor;
    const meal = crypto.randomUUID();
    const item = crypto.randomUUID();
    const batch = [
      ...newMeal(meal, hlc(0, 'phone')),
      ...human(
        'meal_log_items',
        item,
        {
          meal_log_id: meal,
          food_id: foodId,
          quantity: 1.5,
          notes: null,
          deleted_at: null,
        },
        hlc(0, 'phone', 1),
      ),
    ];
    expect((await pushBatch(batch)).every((r) => r.status === 'applied')).toBe(
      true,
    );
    expect((await pushBatch(batch)).every((r) => r.status === 'skipped')).toBe(
      true,
    );

    const row = await mealRow(meal);
    expect(row!.created_at.getTime()).toBe(T); // device time of the first write

    const pulled = await pullSince(before);
    const ids = pulled.changes.map((c) => c.row.id);
    expect(ids).toEqual(expect.arrayContaining([meal, item]));
    const seqs = pulled.changes.map((c) => c.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(pulled.cursor).toBe(seqs.at(-1));
    expect(
      (await pullSince(pulled.cursor)).changes.filter((c) =>
        [meal, item].includes(c.row.id as string),
      ),
    ).toEqual([]);
  });

  it('rejects a child whose parent does not exist yet (incomplete create), without failing the batch', async () => {
    const orphan = crypto.randomUUID();
    const meal = crypto.randomUUID();
    const results = await pushBatch([
      ...human('meal_log_items', orphan, { quantity: 2 }, hlc(0, 'phone')),
      ...newMeal(meal, hlc(1, 'phone')),
    ]);
    expect(results[0]).toMatchObject({ status: 'rejected' });
    expect(results.slice(1).every((r) => r.status === 'applied')).toBe(true);
  });
});

describe('push: concurrent devices (MZY-206 AC1)', () => {
  it('different fields from two devices both survive; same field: later HLC wins in either order', async () => {
    for (const phoneFirst of [true, false]) {
      const meal = crypto.randomUUID();
      await pushBatch(newMeal(meal, hlc(0, 'phone')));

      // Both devices edited offline; laptop's notes edit is the later one.
      const phone = [
        ...human(
          'meal_logs',
          meal,
          { meal_slot: 'lunch' },
          hlc(1_000, 'phone'),
        ),
        ...human(
          'meal_logs',
          meal,
          { notes: 'zz-sync phone' },
          hlc(1_000, 'phone', 1),
        ),
      ];
      const laptop = human(
        'meal_logs',
        meal,
        { notes: 'zz-sync laptop' },
        hlc(2_000, 'laptop'),
      );
      for (const b of phoneFirst ? [phone, laptop] : [laptop, phone])
        await pushBatch(b);

      expect(await mealRow(meal)).toMatchObject({
        meal_slot: 'lunch',
        notes: 'zz-sync laptop',
      });
    }
  });

  it('clamps a stamp from a device clock set far in the future', async () => {
    const meal = crypto.randomUUID();
    await pushBatch(newMeal(meal, hlc(0, 'phone')));
    const future = formatHlc({
      wall: Date.now() + 24 * 3_600_000,
      counter: 0,
      node: 'skewed',
    });
    await pushBatch(
      human('meal_logs', meal, { notes: 'zz-sync skewed' }, future),
    );
    // A normal edit made now still beats it, because the future stamp was clamped.
    await pushBatch(
      human(
        'meal_logs',
        meal,
        { notes: 'zz-sync now' },
        formatHlc({ wall: Date.now() + 1, counter: 0, node: 'phone' }),
      ),
    );
    expect((await mealRow(meal))!.notes).toBe('zz-sync now');
  });
});

describe('push: delete is a tombstone that replicates', () => {
  it('a delete shows up in pull with deleted_at set; an older restore loses, a newer one wins', async () => {
    const meal = crypto.randomUUID();
    await pushBatch(newMeal(meal, hlc(0, 'phone')));
    const cursor = (await pullSince(0)).cursor;

    await pushBatch(
      human(
        'meal_logs',
        meal,
        { deleted_at: new Date(T + 10).toISOString() },
        hlc(10, 'phone'),
      ),
    );
    const tomb = (await pullSince(cursor)).changes.find(
      (c) => c.row.id === meal,
    );
    expect(tomb?.row.deleted_at).not.toBeNull();

    await pushBatch(
      human('meal_logs', meal, { deleted_at: null }, hlc(5, 'laptop')),
    );
    expect((await mealRow(meal))!.deleted_at).not.toBeNull();
    await pushBatch(
      human('meal_logs', meal, { deleted_at: null }, hlc(20, 'laptop')),
    );
    expect((await mealRow(meal))!.deleted_at).toBeNull();
  });
});

describe('natural-key collisions merge into one row (MZY-206 decision 2)', () => {
  it('a second device creating the same medication is aliased; edits and children via the alias land on it', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await pushBatch(
      human(
        'medications',
        a,
        { name: MED, kind: 'supplement', dosage: '200 mg', deleted_at: null },
        hlc(0, 'phone'),
      ),
    );
    const res = await pushBatch(
      human(
        'medications',
        b,
        {
          name: MED,
          kind: 'supplement',
          schedule: 'nightly',
          deleted_at: null,
        },
        hlc(5, 'laptop'),
      ),
    );
    expect(
      res.every((r) => r.status === 'applied' && r.canonicalId === a),
    ).toBe(true);

    // A dose logged on the laptop against its own (aliased) id.
    const dose = crypto.randomUUID();
    await pushBatch(
      human(
        'medication_logs',
        dose,
        { medication_id: b, date: '2026-09-25', quantity: 1, deleted_at: null },
        hlc(6, 'laptop'),
      ),
    );

    const { rows } = await query<{
      id: string;
      dosage: string;
      schedule: string;
    }>('SELECT id, dosage, schedule FROM public.medications WHERE name = $1', [
      MED,
    ]);
    expect(rows).toEqual([{ id: a, dosage: '200 mg', schedule: 'nightly' }]);
    const { rows: doses } = await query(
      'SELECT medication_id FROM public.medication_logs WHERE id = $1',
      [dose],
    );
    expect(doses).toEqual([{ medication_id: a }]);

    const aliases = (await pullSince(0)).aliases;
    expect(aliases).toContainEqual({
      aliasId: b,
      table: 'medications',
      canonicalId: a,
    });
  });
});

describe('human beats machine (MZY-206 AC2)', () => {
  it('a lab re-import never overwrites a hand-corrected value, but still updates untouched fields', async () => {
    const panel = crypto.randomUUID();
    const result = crypto.randomUUID();
    await applyMutations(
      [
        ...rowMutations(
          'lab_panels',
          panel,
          { date: '2026-09-01', panel_type: 'zz-sync-panel' },
          'machine',
          'lab-import',
        ),
        ...rowMutations(
          'lab_panel_results',
          result,
          {
            lab_panel_id: panel,
            marker: 'ferritin',
            value_numeric: 12,
            unit: 'ug/L',
          },
          'machine',
          'lab-import',
        ),
      ],
      { serverWriter: true },
    );
    // Athlete fixes the extracted value on a device (an OLDER clock than the re-import).
    await pushBatch(
      human(
        'lab_panel_results',
        result,
        { value_numeric: 120 },
        hlc(-3_600_000, 'phone'),
      ),
    );
    // Re-import, new stamp, both fields.
    await applyMutations(
      rowMutations(
        'lab_panel_results',
        result,
        { value_numeric: 12, unit: 'µg/L' },
        'machine',
        'lab-import',
      ),
      { serverWriter: true },
    );
    const { rows } = await query(
      'SELECT value_numeric::float AS v, unit FROM public.lab_panel_results WHERE id = $1',
      [result],
    );
    expect(rows).toEqual([{ v: 120, unit: 'µg/L' }]);
  });
});

describe('the whitelist', () => {
  it('rejects unknown tables/fields, bookkeeping columns, bad values and device writes to read-only tables — per mutation', async () => {
    const meal = crypto.randomUUID();
    const results = await pushBatch([
      {
        table: 'runs',
        id: meal,
        field: 'distance_m',
        value: 1,
        hlc: hlc(0, 'p'),
        origin: 'human',
      },
      {
        table: 'meal_logs',
        id: meal,
        field: 'field_hlc',
        value: {},
        hlc: hlc(0, 'p'),
        origin: 'human',
      },
      {
        table: 'meal_logs',
        id: meal,
        field: 'meal_slot',
        value: 'brunch',
        hlc: hlc(0, 'p'),
        origin: 'human',
      },
      {
        table: 'session_adjustments',
        id: meal,
        field: 'note',
        value: 'x',
        hlc: hlc(0, 'p'),
        origin: 'human',
      },
      {
        table: 'meal_logs',
        id: meal,
        field: 'notes',
        value: 'ok',
        hlc: 'not-an-hlc',
        origin: 'human',
      },
      ...newMeal(meal, hlc(0, 'p')),
    ]);
    expect(results.slice(0, 5).map((r) => r.status)).toEqual(
      Array(5).fill('rejected'),
    );
    expect(results.slice(5).every((r) => r.status === 'applied')).toBe(true);
  });

  it('a constraint violation rejects only that row (e.g. unknown food FK)', async () => {
    const meal = crypto.randomUUID();
    const item = crypto.randomUUID();
    const results = await pushBatch([
      ...newMeal(meal, hlc(0, 'p')),
      ...human(
        'meal_log_items',
        item,
        { meal_log_id: meal, food_id: crypto.randomUUID(), quantity: 1 },
        hlc(1, 'p'),
      ),
    ]);
    expect(results.slice(0, 4).every((r) => r.status === 'applied')).toBe(true);
    expect(results.slice(4).every((r) => r.status === 'rejected')).toBe(true);
    expect(await mealRow(meal)).toBeDefined();
  });
});

describe('legacy writers are stamped by the trigger', () => {
  it('a service write outside the push path gets a sync_seq, a server HLC per field and origin human', async () => {
    const before = (await pullSince(0)).cursor;
    const id = await logAdHocMeal({
      date: '2026-09-25',
      mealSlot: 'snack',
      items: [{ food: FOOD, quantity: 1 }],
    });
    const { rows } = await query<{
      sync_seq: string;
      field_hlc: Record<string, { hlc: string; origin: string }>;
      edit_origin: string;
    }>(
      'SELECT sync_seq, field_hlc, edit_origin FROM public.meal_logs WHERE id = $1',
      [id],
    );
    expect(Number(rows[0]!.sync_seq)).toBeGreaterThan(before);
    expect(rows[0]!.edit_origin).toBe('human');
    expect(rows[0]!.field_hlc.meal_slot).toMatchObject({
      origin: 'human',
      hlc: expect.stringMatching(/:server$/),
    });
  });
});

describe('tombstones are invisible to readers (MZY-206 AC3)', () => {
  it('a deleted meal drops out of the PWA list, the daily totals and the MCP nutrition summary', async () => {
    const day = '2026-09-25';
    const id = await logAdHocMeal({
      date: day,
      mealSlot: 'dinner',
      items: [{ food: FOOD, quantity: 2 }],
    });
    const kcalBefore = (await getDailyNutritionTotals(day)).kcal;
    expect((await listMealLogsForDate(day)).map((m) => m.id)).toContain(id);
    expect(await nutritionSummary(day)).toContain(
      `**Logged intake today:** ${kcalBefore} kcal`,
    );

    expect(await deleteMealLog(id)).toBe(true);
    expect(await deleteMealLog(id)).toBe(false); // soft + idempotent

    expect((await listMealLogsForDate(day)).map((m) => m.id)).not.toContain(id);
    expect((await getDailyNutritionTotals(day)).kcal).toBe(kcalBefore - 260);
    const { rows } = await query(
      'SELECT deleted_at IS NOT NULL AS gone FROM public.meal_logs WHERE id = $1',
      [id],
    );
    expect(rows).toEqual([{ gone: true }]); // still there as a tombstone for pull
    expect(await nutritionSummary(day)).not.toContain(`${kcalBefore} kcal`);
  });
});

describe('the lab-PDF import is a machine writer (scripts/import-lab-results.ts)', () => {
  it('re-running the import keeps a value the athlete corrected on a device', async () => {
    const extract = {
      marker: 'vitamin_d',
      valueNumeric: 18,
      unit: 'ng/mL',
      sourceFile: 'zz.pdf',
      confidence: 0.6,
      model: 'test',
    };
    const panel = await findOrCreateLabPanel({
      date: '2026-09-02',
      panelType: 'zz-sync-panel',
    });
    await upsertLabResult(panel, extract);
    const { rows } = await query<{ id: string; edit_origin: string }>(
      `SELECT id, edit_origin FROM public.lab_panel_results WHERE lab_panel_id = $1 AND marker = 'vitamin_d'`,
      [panel],
    );
    expect(rows[0]!.edit_origin).toBe('machine');

    await pushBatch(
      human(
        'lab_panel_results',
        rows[0]!.id,
        { value_numeric: 81 },
        hlc(0, 'phone'),
      ),
    );
    expect(
      await findOrCreateLabPanel({
        date: '2026-09-02',
        panelType: 'zz-sync-panel',
      }),
    ).toBe(panel);
    await upsertLabResult(panel, { ...extract, unit: 'ng/ml' });

    const { rows: after } = await query(
      `SELECT value_numeric::float AS v, unit FROM public.lab_panel_results WHERE id = $1`,
      [rows[0]!.id],
    );
    expect(after).toEqual([{ v: 81, unit: 'ng/ml' }]);
  });
});

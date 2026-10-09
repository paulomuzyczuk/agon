import {
  adHocMealRows,
  deleteRows,
  healthEntryRows,
  routineDoneRows,
  wholeTemplateRows,
} from '@/lib/sync/entryRows';
import { SYNC_TABLES, type SyncTableName } from '@/lib/sync/schema';
import type { SyncRow } from '@/lib/outboxQueue';

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
}

// Every row a form produces must pass the same whitelist the server enforces,
// and a new row must carry every field the table requires.
function expectValidNewRows(rows: SyncRow[]) {
  for (const r of rows) {
    const spec = SYNC_TABLES[r.table as SyncTableName];
    expect(spec).toBeDefined();
    for (const [field, value] of Object.entries(r.values)) {
      const schema = (spec.fields as Record<string, { safeParse(v: unknown): { success: boolean } }>)[field];
      expect(`${r.table}.${field}:${!!schema && schema.safeParse(value).success}`).toBe(`${r.table}.${field}:true`);
    }
    for (const req of spec.required) expect(r.values[req]).not.toBeUndefined();
  }
}

describe('healthEntryRows', () => {
  it('lab panel → header + one result per marker, linked by the header id', () => {
    const rows = healthEntryRows(
      {
        mode: 'lab_panel',
        date: '2026-09-01',
        panelType: 'blood panel',
        results: [
          { marker: 'ferritin', valueNumeric: 80, unit: 'ug/L' },
          { marker: 'blood type', valueText: 'A+' },
        ],
      },
      ids(),
    );
    expect(rows.map((r) => r.table)).toEqual(['lab_panels', 'lab_panel_results', 'lab_panel_results']);
    expect(rows[1]!.values.lab_panel_id).toBe(rows[0]!.id);
    expect(rows[2]!.values).toMatchObject({ value_numeric: null, value_text: 'A+', unit: null });
    expectValidNewRows(rows);
  });

  it('routine → header + ordered steps', () => {
    const rows = healthEntryRows(
      { mode: 'new_routine', name: 'PM skin', routineType: 'skincare', steps: [{ product: 'cleanser' }, { product: 'retinol' }] },
      ids(),
    );
    expect(rows.slice(1).map((r) => [r.values.routine_id, r.values.step_order])).toEqual([
      [rows[0]!.id, 0],
      [rows[0]!.id, 1],
    ]);
    expectValidNewRows(rows);
  });

  it.each([
    { mode: 'medication', name: 'Magnesium', kind: 'supplement' },
    { mode: 'injury', onsetDate: '2026-09-01', bodyPart: 'left calf', severity: 4 },
    { mode: 'medical_visit', date: '2026-09-01', visitType: 'physio', followUpDate: '2026-09-15' },
    { mode: 'vaccination', date: '2026-09-01', vaccine: 'tetanus', doseNumber: 2 },
    { mode: 'health_condition', conditionType: 'allergy', name: 'pollen' },
  ] as const)('$mode → one valid new row with deleted_at: null (restores on re-create)', (entry) => {
    const rows = healthEntryRows(entry, ids());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values.deleted_at).toBeNull();
    expectValidNewRows(rows);
  });

  it('empty optional fields become null, not undefined (so they are written)', () => {
    const [row] = healthEntryRows({ mode: 'medication', name: 'X', kind: 'medication', dosage: '' }, ids());
    expect(row!.values).toMatchObject({ dosage: null, schedule: null, notes: null, active: true });
  });
});

describe('meal rows', () => {
  it('ad-hoc meal → header + items linked to it', () => {
    const rows = adHocMealRows(
      { date: '2026-09-24', mealSlot: 'dinner', items: [{ foodId: '11111111-1111-4111-8111-111111111111', quantity: 1.5 }] },
      ids(),
    );
    expect(rows[1]!.values.meal_log_id).toBe(rows[0]!.id);
    expectValidNewRows(rows);
  });

  it('whole template → one meal per slot, each with only that slot’s items', () => {
    const food = '11111111-1111-4111-8111-111111111111';
    const rows = wholeTemplateRows(
      {
        date: '2026-09-24',
        templateId: '22222222-2222-4222-8222-222222222222',
        items: [
          { mealSlot: 'breakfast', foodId: food, quantity: 1 },
          { mealSlot: 'snack', foodId: food, quantity: 2 },
          { mealSlot: 'breakfast', foodId: food, quantity: 3 },
        ],
      },
      ids(),
    );
    const meals = rows.filter((r) => r.table === 'meal_logs');
    expect(meals.map((m) => m.values.meal_slot)).toEqual(['breakfast', 'snack']);
    const breakfastItems = rows.filter((r) => r.values.meal_log_id === meals[0]!.id);
    expect(breakfastItems.map((i) => i.values.quantity)).toEqual([1, 3]);
    expectValidNewRows(rows);
  });

  it('routine check-off and undo', () => {
    expectValidNewRows(routineDoneRows('33333333-3333-4333-8333-333333333333', '2026-09-24', ids()));
    expect(deleteRows('meal_logs', 'm', '2026-09-24T21:00:00.000Z')).toEqual([
      { table: 'meal_logs', id: 'm', values: { deleted_at: '2026-09-24T21:00:00.000Z' } },
    ]);
  });
});

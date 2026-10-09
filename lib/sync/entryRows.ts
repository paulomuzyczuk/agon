import type { SyncRow } from '../outboxQueue';

// PWA form submissions → replicated rows (MZY-206). Since phase 2 the device
// writes field-level rows itself instead of calling the mode-based
// /api/general-health/log and /api/nutrition/log endpoints, so what those
// endpoints' services used to assemble server-side (a panel + its results, a
// routine + its steps, a meal + its items) is assembled here. Pure and
// unit-tested; ids come from the caller so the same action is reproducible.
//
// New rows carry every field explicitly (optional ones as null) and
// deleted_at: null — so re-creating a natural-key row that was deleted
// (e.g. adding a medication again) restores it on merge.

export type NewId = () => string;

const opt = <T>(v: T | undefined | ''): T | null => (v === undefined || v === '' ? null : v);

export type HealthEntry =
  | {
      mode: 'lab_panel';
      date: string;
      panelType: string;
      labName?: string;
      notes?: string;
      results: { marker: string; valueNumeric?: number; valueText?: string; unit?: string }[];
    }
  | {
      mode: 'medication';
      name: string;
      kind: 'medication' | 'supplement';
      dosage?: string;
      schedule?: string;
      active?: boolean;
      notes?: string;
    }
  | {
      mode: 'injury';
      onsetDate: string;
      bodyPart: string;
      description?: string;
      severity?: number;
      notes?: string;
    }
  | {
      mode: 'medical_visit';
      date: string;
      visitType: string;
      provider?: string;
      reason?: string;
      findings?: string;
      followUpDate?: string;
      notes?: string;
    }
  | {
      mode: 'vaccination';
      date: string;
      vaccine: string;
      doseNumber?: number;
      provider?: string;
      nextDueDate?: string;
      notes?: string;
    }
  | {
      mode: 'health_condition';
      conditionType: 'allergy' | 'chronic_condition' | 'other';
      name: string;
      severity?: string;
      diagnosedDate?: string;
      status?: 'active' | 'resolved' | 'managed';
      notes?: string;
    }
  | {
      mode: 'new_routine';
      name: string;
      routineType: 'skincare' | 'dental';
      timeOfDay?: 'am' | 'pm' | 'any';
      notes?: string;
      steps: { product: string; notes?: string }[];
    };

export function healthEntryRows(e: HealthEntry, newId: NewId): SyncRow[] {
  switch (e.mode) {
    case 'lab_panel': {
      const panel = newId();
      return [
        {
          table: 'lab_panels',
          id: panel,
          values: {
            date: e.date,
            panel_type: e.panelType,
            lab_name: opt(e.labName),
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
        ...e.results.map((r) => ({
          table: 'lab_panel_results',
          id: newId(),
          values: {
            lab_panel_id: panel,
            marker: r.marker,
            value_numeric: opt(r.valueNumeric),
            value_text: opt(r.valueText),
            unit: opt(r.unit),
            deleted_at: null,
          },
        })),
      ];
    }
    case 'medication':
      return [
        {
          table: 'medications',
          id: newId(),
          values: {
            name: e.name,
            kind: e.kind,
            dosage: opt(e.dosage),
            schedule: opt(e.schedule),
            active: e.active ?? true,
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
      ];
    case 'injury':
      return [
        {
          table: 'injuries',
          id: newId(),
          values: {
            onset_date: e.onsetDate,
            body_part: e.bodyPart,
            description: opt(e.description),
            severity: opt(e.severity),
            status: 'active',
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
      ];
    case 'medical_visit':
      return [
        {
          table: 'medical_visits',
          id: newId(),
          values: {
            date: e.date,
            visit_type: e.visitType,
            provider: opt(e.provider),
            reason: opt(e.reason),
            findings: opt(e.findings),
            follow_up_date: opt(e.followUpDate),
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
      ];
    case 'vaccination':
      return [
        {
          table: 'vaccinations',
          id: newId(),
          values: {
            date: e.date,
            vaccine: e.vaccine,
            dose_number: opt(e.doseNumber),
            provider: opt(e.provider),
            next_due_date: opt(e.nextDueDate),
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
      ];
    case 'health_condition':
      return [
        {
          table: 'health_conditions',
          id: newId(),
          values: {
            condition_type: e.conditionType,
            name: e.name,
            severity: opt(e.severity),
            diagnosed_date: opt(e.diagnosedDate),
            status: e.status ?? 'active',
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
      ];
    case 'new_routine': {
      const routine = newId();
      return [
        {
          table: 'routines',
          id: routine,
          values: {
            name: e.name,
            routine_type: e.routineType,
            time_of_day: opt(e.timeOfDay),
            notes: opt(e.notes),
            deleted_at: null,
          },
        },
        ...e.steps.map((s, i) => ({
          table: 'routine_steps',
          id: newId(),
          values: {
            routine_id: routine,
            step_order: i,
            product: s.product,
            notes: opt(s.notes),
            deleted_at: null,
          },
        })),
      ];
    }
  }
}

/** Routine check-off: natural key (date, routine) — a repeat merges server-side. */
export function routineDoneRows(routineId: string, date: string, newId: NewId): SyncRow[] {
  return [
    {
      table: 'routine_logs',
      id: newId(),
      values: { date, routine_id: routineId, completed: true, notes: null, deleted_at: null },
    },
  ];
}

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'post_workout' | 'other';

/** An ad-hoc meal: header + one item per food. */
export function adHocMealRows(
  input: { date: string; mealSlot: MealSlot; items: { foodId: string; quantity: number }[] },
  newId: NewId,
): SyncRow[] {
  const meal = newId();
  return [
    {
      table: 'meal_logs',
      id: meal,
      values: {
        date: input.date,
        meal_slot: input.mealSlot,
        meal_template_id: null,
        source: 'manual',
        notes: null,
        deleted_at: null,
      },
    },
    ...input.items.map((i) => ({
      table: 'meal_log_items',
      id: newId(),
      values: { meal_log_id: meal, food_id: i.foodId, quantity: i.quantity, notes: null, deleted_at: null },
    })),
  ];
}

/** A whole template for a day: one meal per slot it has, each with that slot's items. */
export function wholeTemplateRows(
  input: {
    date: string;
    templateId: string;
    items: { mealSlot: string; foodId: string; quantity: number }[];
  },
  newId: NewId,
): SyncRow[] {
  const slots = [...new Set(input.items.map((i) => i.mealSlot))];
  return slots.flatMap((slot) => {
    const meal = newId();
    return [
      {
        table: 'meal_logs',
        id: meal,
        values: {
          date: input.date,
          meal_slot: slot,
          meal_template_id: input.templateId,
          source: 'template',
          notes: null,
          deleted_at: null,
        },
      },
      ...input.items
        .filter((i) => i.mealSlot === slot)
        .map((i) => ({
          table: 'meal_log_items',
          id: newId(),
          values: { meal_log_id: meal, food_id: i.foodId, quantity: i.quantity, notes: null, deleted_at: null },
        })),
    ];
  });
}

/** Undo a logged meal: a tombstone, stamped with the device time. */
export function deleteRows(table: string, id: string, nowISO: string): SyncRow[] {
  return [{ table, id, values: { deleted_at: nowISO } }];
}

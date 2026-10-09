import { z } from 'zod';

// Replicated tables and their syncable fields (MZY-28 decision 1, MZY-206).
// The single whitelist both sides use: the server validates every pushed
// field value against it (anything not listed is rejected), and the client
// builds its mutations from it. Keep in step with migrations/ — the
// integration suite checks every listed field exists as a column.
//
// Not listed on purpose: `id` (the mutation's row key), `created_at` /
// `updated_at` (server-maintained), and the sync bookkeeping columns
// (`sync_seq`, `field_hlc`, `edit_origin`) — except `deleted_at`, which IS a
// field: deleting is writing it, restoring is writing null.

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime({ offset: true });
const text = z.string().max(10_000);
const nText = text.nullable();
const nNum = z.number().finite().nullable();
const posNum = z.number().finite().positive();
const nInt = z.number().int().nullable();

export interface SyncTable {
  /** Field -> value schema. */
  fields: Record<string, z.ZodTypeAny>;
  /** Fields a new row must have (NOT NULL without a DB default). */
  required: string[];
  /** FK fields that point at another replicated table (for id aliasing). */
  refs: Record<string, string>;
  /** A UNIQUE natural key: a second create with it merges into the first row. */
  naturalKey?: string[];
  /** Pushable from devices. False = replicated for reading only (server writes). */
  pushable: boolean;
}

const deletedAt = { deleted_at: instant.nullable() };

export const SYNC_TABLES = {
  meal_logs: {
    fields: {
      date,
      meal_slot: z.enum([
        'breakfast',
        'lunch',
        'dinner',
        'snack',
        'post_workout',
        'other',
      ]),
      meal_template_id: uuid.nullable(),
      source: z.enum(['manual', 'telegram', 'template']),
      notes: nText,
      ...deletedAt,
    },
    required: ['date', 'meal_slot'],
    refs: {},
    pushable: true,
  },
  meal_log_items: {
    fields: {
      meal_log_id: uuid,
      food_id: uuid,
      quantity: posNum,
      notes: nText,
      ...deletedAt,
    },
    required: ['meal_log_id', 'food_id', 'quantity'],
    refs: { meal_log_id: 'meal_logs' },
    pushable: true,
  },
  health_conditions: {
    fields: {
      condition_type: z.enum(['allergy', 'chronic_condition', 'other']),
      name: text.min(1),
      severity: nText,
      diagnosed_date: date.nullable(),
      status: z.enum(['active', 'resolved', 'managed']),
      notes: nText,
      ...deletedAt,
    },
    required: ['condition_type', 'name'],
    refs: {},
    naturalKey: ['condition_type', 'name'],
    pushable: true,
  },
  injuries: {
    fields: {
      onset_date: date,
      body_part: text.min(1),
      description: nText,
      severity: z.number().int().min(1).max(10).nullable(),
      status: z.enum(['active', 'improving', 'resolved']),
      resolved_date: date.nullable(),
      notes: nText,
      ...deletedAt,
    },
    required: ['onset_date', 'body_part'],
    refs: {},
    pushable: true,
  },
  injury_updates: {
    fields: {
      injury_id: uuid,
      date,
      severity: z.number().int().min(1).max(10).nullable(),
      status: z.enum(['active', 'improving', 'resolved']).nullable(),
      notes: nText,
      ...deletedAt,
    },
    required: ['injury_id', 'date'],
    refs: { injury_id: 'injuries' },
    pushable: true,
  },
  medications: {
    fields: {
      name: text.min(1),
      kind: z.enum(['medication', 'supplement']),
      dosage: nText,
      schedule: nText,
      active: z.boolean(),
      notes: nText,
      ...deletedAt,
    },
    required: ['name', 'kind'],
    refs: {},
    naturalKey: ['name'],
    pushable: true,
  },
  medication_logs: {
    fields: {
      medication_id: uuid,
      date,
      taken_at: instant.nullable(),
      quantity: posNum,
      notes: nText,
      ...deletedAt,
    },
    required: ['medication_id', 'date'],
    refs: { medication_id: 'medications' },
    pushable: true,
  },
  medical_visits: {
    fields: {
      date,
      visit_type: text.min(1),
      provider: nText,
      reason: nText,
      findings: nText,
      follow_up_date: date.nullable(),
      notes: nText,
      ...deletedAt,
    },
    required: ['date', 'visit_type'],
    refs: {},
    pushable: true,
  },
  vaccinations: {
    fields: {
      vaccine: text.min(1),
      date,
      dose_number: nInt,
      provider: nText,
      next_due_date: date.nullable(),
      notes: nText,
      ...deletedAt,
    },
    required: ['vaccine', 'date'],
    refs: {},
    pushable: true,
  },
  routines: {
    fields: {
      name: text.min(1),
      routine_type: z.enum(['skincare', 'dental']),
      time_of_day: z.enum(['am', 'pm', 'any']).nullable(),
      notes: nText,
      ...deletedAt,
    },
    required: ['name', 'routine_type'],
    refs: {},
    naturalKey: ['name'],
    pushable: true,
  },
  routine_steps: {
    fields: {
      routine_id: uuid,
      step_order: z.number().int().min(0),
      product: text.min(1),
      notes: nText,
      ...deletedAt,
    },
    required: ['routine_id', 'product'],
    refs: { routine_id: 'routines' },
    pushable: true,
  },
  routine_logs: {
    fields: {
      date,
      routine_id: uuid,
      completed: z.boolean(),
      notes: nText,
      ...deletedAt,
    },
    required: ['date', 'routine_id'],
    refs: { routine_id: 'routines' },
    naturalKey: ['date', 'routine_id'],
    pushable: true,
  },
  lab_panels: {
    fields: {
      date,
      panel_type: text.min(1),
      lab_name: nText,
      notes: nText,
      ...deletedAt,
    },
    required: ['date', 'panel_type'],
    refs: {},
    pushable: true,
  },
  lab_panel_results: {
    fields: {
      lab_panel_id: uuid,
      marker: text.min(1),
      value_numeric: nNum,
      value_text: nText,
      unit: nText,
      reference_low: nNum,
      reference_high: nNum,
      flag: z.enum(['low', 'normal', 'high', 'abnormal']).nullable(),
      notes: nText,
      source_file: nText,
      confidence: z.number().min(0).max(1).nullable(),
      needs_review: z.boolean(),
      model: nText,
      ...deletedAt,
    },
    required: ['lab_panel_id', 'marker'],
    refs: { lab_panel_id: 'lab_panels' },
    naturalKey: ['lab_panel_id', 'marker'],
    pushable: true,
  },
  // Replicated so devices can read hand-made plan changes, but not pushable
  // from the PWA in v1 (MZY-28 open question 2: adjustments arrive via
  // Calendar/Telegram only). Server writers use services/sync/apply.ts.
  session_adjustments: {
    fields: {
      planned_session_id: uuid,
      date: date.nullable(),
      description: nText,
      target_distance_km: z.number().min(0).nullable(),
      target_hr_cap: z.number().int().min(0).max(260).nullable(),
      target_session_type: nText,
      note: nText,
      detail: nText,
      source: z.enum(['manual', 'calendar']),
      ...deletedAt,
    },
    required: ['planned_session_id'],
    refs: {},
    naturalKey: ['planned_session_id'],
    pushable: false,
  },
} satisfies Record<string, SyncTable>;

export type SyncTableName = keyof typeof SYNC_TABLES;

export const SYNC_TABLE_NAMES = Object.keys(SYNC_TABLES) as SyncTableName[];

export function isSyncTable(name: string): name is SyncTableName {
  return Object.prototype.hasOwnProperty.call(SYNC_TABLES, name);
}

export function syncTable(name: SyncTableName): SyncTable {
  return SYNC_TABLES[name] as SyncTable;
}

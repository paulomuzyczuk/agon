import type { PoolClient } from 'pg';
import { query, withTransaction } from './db';
import { getMealTemplate } from './mealTemplates';
import { findFoodByName } from './foods';
import { deriveUuid } from './clientWrite';

// Structured daily intake — the "macro counting" capture path. Mirrors
// run_fueling_items: one row per food eaten, grouped under a meal_logs header
// row per meal slot, so totals can be summed and compared against
// nutrition_goals. A meal can be logged from a template (fast path — copies its
// items) or built ad hoc from the foods catalog.

export type MealSlot =
  'breakfast' | 'lunch' | 'dinner' | 'snack' | 'post_workout' | 'other';

export interface AdHocMealItem {
  food: string; // resolved against the foods catalog by name
  quantity: number;
}

/**
 * Insert a meal_logs header idempotently (MZY-205). With a client `id` a
 * replayed write conflicts on the primary key and returns `inserted: false`,
 * and the caller must then skip the child items — they were written with the
 * header the first time. `capturedAt` (device clock) becomes created_at.
 */
async function insertMealLogHeader(
  client: PoolClient,
  row: {
    id?: string;
    date: string;
    mealSlot: MealSlot;
    templateId: string | null;
    source: 'manual' | 'telegram' | 'template';
    notes: string | null;
    capturedAt?: string;
  },
): Promise<{ id: string; inserted: boolean }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.meal_logs (id, date, meal_slot, meal_template_id, source, notes, created_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6,
             COALESCE($7::timestamptz, now()))
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      row.id ?? null,
      row.date,
      row.mealSlot,
      row.templateId,
      row.source,
      row.notes,
      row.capturedAt ?? null,
    ],
  );
  if (rows[0]) return { id: rows[0].id, inserted: true };
  return { id: row.id!, inserted: false };
}

/** Log a meal built from named foods + quantities (manual or voice capture). */
export async function logAdHocMeal(input: {
  id?: string;
  capturedAt?: string;
  date: string;
  mealSlot: MealSlot;
  items: AdHocMealItem[];
  source?: 'manual' | 'telegram';
  notes?: string | null;
}): Promise<string> {
  return withTransaction(async (client) => {
    const header = await insertMealLogHeader(client, {
      id: input.id,
      date: input.date,
      mealSlot: input.mealSlot,
      templateId: null,
      source: input.source ?? 'manual',
      notes: input.notes ?? null,
      capturedAt: input.capturedAt,
    });
    if (!header.inserted) return header.id; // replay — items already written

    for (const item of input.items) {
      const food = await findFoodByName(item.food);
      if (!food) {
        throw new Error(
          `Unmatched food "${item.food}" — add it to the foods catalog before logging.`,
        );
      }
      await client.query(
        `INSERT INTO public.meal_log_items (meal_log_id, food_id, quantity)
         VALUES ($1,$2,$3)`,
        [header.id, food.id, item.quantity],
      );
    }
    return header.id;
  });
}

/** Log a meal by copying a template's items verbatim for `date`. */
export async function logMealFromTemplate(input: {
  id?: string;
  capturedAt?: string;
  date: string;
  mealSlot: MealSlot;
  templateName: string;
  notes?: string | null;
}): Promise<string> {
  const template = await getMealTemplate(input.templateName);
  if (!template) {
    throw new Error(`Unknown meal template "${input.templateName}".`);
  }
  const items = template.items.filter((i) => i.mealSlot === input.mealSlot);

  return withTransaction((client) =>
    insertTemplateMealLog(client, {
      id: input.id,
      capturedAt: input.capturedAt,
      date: input.date,
      mealSlot: input.mealSlot,
      templateId: template.id,
      items,
      notes: input.notes ?? null,
    }),
  );
}

/**
 * Log an ENTIRE template for `date` in one action — one meal_logs row per
 * slot the template actually has (e.g. breakfast + lunch + snack +
 * post_workout), each carrying that slot's items. The PWA's "log this whole
 * plan for today" shortcut.
 *
 * With a client `id`, each slot's row id is derived from it (deriveUuid), so
 * a replay of the same mutation conflicts on every row instead of logging the
 * whole plan twice.
 */
export async function logWholeTemplateForDate(input: {
  id?: string;
  capturedAt?: string;
  date: string;
  templateName: string;
}): Promise<string[]> {
  const template = await getMealTemplate(input.templateName);
  if (!template) {
    throw new Error(`Unknown meal template "${input.templateName}".`);
  }
  const slots = [
    ...new Set(template.items.map((i) => i.mealSlot)),
  ] as MealSlot[];

  return withTransaction(async (client) => {
    const ids: string[] = [];
    for (const slot of slots) {
      const items = template.items.filter((i) => i.mealSlot === slot);
      ids.push(
        await insertTemplateMealLog(client, {
          id: input.id ? deriveUuid(input.id, slot) : undefined,
          capturedAt: input.capturedAt,
          date: input.date,
          mealSlot: slot,
          templateId: template.id,
          items,
          notes: null,
        }),
      );
    }
    return ids;
  });
}

async function insertTemplateMealLog(
  client: PoolClient,
  row: {
    id?: string;
    capturedAt?: string;
    date: string;
    mealSlot: MealSlot;
    templateId: string;
    items: { foodId: string; quantity: number }[];
    notes: string | null;
  },
): Promise<string> {
  const header = await insertMealLogHeader(client, {
    id: row.id,
    date: row.date,
    mealSlot: row.mealSlot,
    templateId: row.templateId,
    source: 'template',
    notes: row.notes,
    capturedAt: row.capturedAt,
  });
  if (!header.inserted) return header.id; // replay — items already written

  for (const item of row.items) {
    await client.query(
      `INSERT INTO public.meal_log_items (meal_log_id, food_id, quantity)
       VALUES ($1,$2,$3)`,
      [header.id, item.foodId, item.quantity],
    );
  }
  return header.id;
}

export interface DailyNutritionTotals {
  date: string;
  kcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

/** Sum of all logged food-level macros for a date — the "actual" side of macro counting. */
export async function getDailyNutritionTotals(
  date: string,
): Promise<DailyNutritionTotals> {
  const { rows } = await query<{
    kcal: string | null;
    protein_g: string | null;
    carbs_g: string | null;
    fat_g: string | null;
  }>(
    `SELECT
       SUM(mli.quantity * f.kcal)      AS kcal,
       SUM(mli.quantity * f.protein_g) AS protein_g,
       SUM(mli.quantity * f.carbs_g)   AS carbs_g,
       SUM(mli.quantity * f.fat_g)     AS fat_g
     FROM public.meal_log_items mli
     JOIN public.meal_logs ml ON ml.id = mli.meal_log_id
     JOIN public.foods f      ON f.id = mli.food_id
     WHERE ml.date = $1 AND ml.deleted_at IS NULL AND mli.deleted_at IS NULL`,
    [date],
  );
  const r = rows[0];
  return {
    date,
    kcal: Number(r?.kcal ?? 0),
    proteinG: Number(r?.protein_g ?? 0),
    carbsG: Number(r?.carbs_g ?? 0),
    fatG: Number(r?.fat_g ?? 0),
  };
}

export interface MealLogItemSummary {
  id: string;
  foodName: string;
  quantity: number;
}

export interface MealLogSummary {
  id: string;
  mealSlot: MealSlot;
  source: string;
  templateName: string | null;
  notes: string | null;
  items: MealLogItemSummary[];
  totals: { kcal: number; proteinG: number; carbsG: number; fatG: number };
}

/** Every logged meal for a date, with items + per-meal totals — for the PWA's "today's log" list. */
export async function listMealLogsForDate(
  date: string,
): Promise<MealLogSummary[]> {
  const { rows: logRows } = await query<{
    id: string;
    meal_slot: MealSlot;
    source: string;
    template_name: string | null;
    notes: string | null;
  }>(
    `SELECT ml.id, ml.meal_slot, ml.source, mt.name AS template_name, ml.notes
       FROM public.meal_logs ml
       LEFT JOIN public.meal_templates mt ON mt.id = ml.meal_template_id
      WHERE ml.date = $1 AND ml.deleted_at IS NULL
      ORDER BY ml.created_at`,
    [date],
  );
  if (logRows.length === 0) return [];

  const { rows: itemRows } = await query<{
    id: string;
    meal_log_id: string;
    food_name: string;
    quantity: string;
    kcal: string;
    protein_g: string;
    carbs_g: string;
    fat_g: string;
  }>(
    `SELECT mli.id, mli.meal_log_id, f.name AS food_name, mli.quantity,
            (mli.quantity * f.kcal)      AS kcal,
            (mli.quantity * f.protein_g) AS protein_g,
            (mli.quantity * f.carbs_g)   AS carbs_g,
            (mli.quantity * f.fat_g)     AS fat_g
       FROM public.meal_log_items mli
       JOIN public.foods f ON f.id = mli.food_id
      WHERE mli.meal_log_id = ANY($1::uuid[]) AND mli.deleted_at IS NULL`,
    [logRows.map((r) => r.id)],
  );

  return logRows.map((log) => {
    const items = itemRows.filter((i) => i.meal_log_id === log.id);
    return {
      id: log.id,
      mealSlot: log.meal_slot,
      source: log.source,
      templateName: log.template_name,
      notes: log.notes,
      items: items.map((i) => ({
        id: i.id,
        foodName: i.food_name,
        quantity: Number(i.quantity),
      })),
      totals: {
        kcal: Math.round(items.reduce((s, i) => s + Number(i.kcal), 0)),
        proteinG: Math.round(
          items.reduce((s, i) => s + Number(i.protein_g), 0),
        ),
        carbsG: Math.round(items.reduce((s, i) => s + Number(i.carbs_g), 0)),
        fatG: Math.round(items.reduce((s, i) => s + Number(i.fat_g), 0)),
      },
    };
  });
}

/**
 * Delete one logged meal. Soft (MZY-206): sets the deleted_at tombstone so
 * the delete replicates to other devices; readers filter it out, and its
 * items become unreachable with it. Returns false if it didn't exist or was
 * already deleted.
 */
export async function deleteMealLog(id: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE public.meal_logs SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

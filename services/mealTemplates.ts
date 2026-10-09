import { query, withTransaction } from './db';
import { findFoodByName } from './foods';
import type { MealTemplateSpec } from '../lib/mealTemplates';

// Meal template catalog ("usual meals") + structured daily intake logging.
// Templates mirror the fueling_products / run_fueling_items shape: a reusable
// definition (this file) and per-day realized rows (services/mealLogs.ts).

/**
 * Upsert one meal template + its items, idempotent on template name. Replaces
 * the item list wholesale on re-seed (simplest correct behavior for a small,
 * hand-curated set — matches how scripts/seed-planned-sessions.ts treats its
 * program-derived rows: the seed file is the source of truth).
 */
export async function upsertMealTemplate(spec: MealTemplateSpec): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.meal_templates (name, context, block, notes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE SET
         context = EXCLUDED.context, block = EXCLUDED.block, notes = EXCLUDED.notes
       RETURNING id`,
      [spec.name, spec.context ?? null, spec.block ?? null, spec.notes ?? null],
    );
    const templateId = rows[0]!.id;

    await client.query(
      `DELETE FROM public.meal_template_items WHERE meal_template_id = $1`,
      [templateId],
    );

    let order = 0;
    for (const item of spec.items) {
      const food = await findFoodByName(item.food);
      if (!food) {
        throw new Error(
          `Meal template "${spec.name}" references unknown food "${item.food}" — add it to lib/foodCatalog.ts first.`,
        );
      }
      await client.query(
        `INSERT INTO public.meal_template_items
           (meal_template_id, meal_slot, item_order, food_id, quantity)
         VALUES ($1,$2,$3,$4,$5)`,
        [templateId, item.mealSlot, order, food.id, item.quantity],
      );
      order += 1;
    }
  });
}

export interface MealTemplateItemRow {
  mealSlot: string;
  foodId: string;
  foodName: string;
  quantity: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  kcal: number;
}

export interface MealTemplateWithItems {
  id: string;
  name: string;
  context: string | null;
  block: number | null;
  items: MealTemplateItemRow[];
}

/** A template with its items and each item's macros (quantity × per-serving food macros). */
export async function getMealTemplate(
  name: string,
): Promise<MealTemplateWithItems | null> {
  const { rows: tRows } = await query<{
    id: string;
    name: string;
    context: string | null;
    block: number | null;
  }>(
    `SELECT id, name, context, block FROM public.meal_templates WHERE lower(name) = lower($1)`,
    [name],
  );
  const t = tRows[0];
  if (!t) return null;

  const { rows: iRows } = await query<{
    meal_slot: string;
    food_id: string;
    food_name: string;
    quantity: string;
    carbs_g: string;
    protein_g: string;
    fat_g: string;
    kcal: string;
  }>(
    `SELECT mti.meal_slot, mti.food_id, f.name AS food_name, mti.quantity,
            (mti.quantity * f.carbs_g)   AS carbs_g,
            (mti.quantity * f.protein_g) AS protein_g,
            (mti.quantity * f.fat_g)     AS fat_g,
            (mti.quantity * f.kcal)      AS kcal
       FROM public.meal_template_items mti
       JOIN public.foods f ON f.id = mti.food_id
      WHERE mti.meal_template_id = $1
      ORDER BY mti.item_order`,
    [t.id],
  );

  return {
    id: t.id,
    name: t.name,
    context: t.context,
    block: t.block,
    items: iRows.map((r) => ({
      mealSlot: r.meal_slot,
      foodId: r.food_id,
      foodName: r.food_name,
      quantity: Number(r.quantity),
      carbsG: Number(r.carbs_g),
      proteinG: Number(r.protein_g),
      fatG: Number(r.fat_g),
      kcal: Number(r.kcal),
    })),
  };
}

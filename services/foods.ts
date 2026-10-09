import { query } from './db';
import type { FoodSpec } from '../lib/foodCatalog';

// Food catalog. Voice-note / manual meal logging resolves a food name against
// this catalog exactly like services/fueling.ts resolves fueling products —
// same rationale: fuzzy matching risks attributing the wrong macros, so an
// unmatched name should be flagged for a catalog add, not guessed.

export interface FoodMatch {
  id: string;
  name: string;
  servingQty: number;
  servingUnit: string;
  carbsG: number;
  proteinG: number;
  fatG: number;
  kcal: number;
}

interface FoodRow {
  id: string;
  name: string;
  serving_qty: string;
  serving_unit: string;
  carbs_g: string;
  protein_g: string;
  fat_g: string;
  kcal: string;
}

function toMatch(r: FoodRow): FoodMatch {
  return {
    id: r.id,
    name: r.name,
    servingQty: Number(r.serving_qty),
    servingUnit: r.serving_unit,
    carbsG: Number(r.carbs_g),
    proteinG: Number(r.protein_g),
    fatG: Number(r.fat_g),
    kcal: Number(r.kcal),
  };
}

/** Resolve a food name to a catalog row, case-insensitively (exact match only). */
export async function findFoodByName(name: string): Promise<FoodMatch | null> {
  const { rows } = await query<FoodRow>(
    `SELECT id, name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal
       FROM public.foods
      WHERE lower(name) = lower($1)
      LIMIT 1`,
    [name],
  );
  return rows[0] ? toMatch(rows[0]) : null;
}

export async function listFoods(): Promise<FoodMatch[]> {
  const { rows } = await query<FoodRow>(
    `SELECT id, name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal
       FROM public.foods
      ORDER BY name`,
  );
  return rows.map(toMatch);
}

/** Upsert a catalog food (idempotent on name). Used by the seed script. */
export async function upsertFood(f: FoodSpec): Promise<void> {
  await query(
    `INSERT INTO public.foods
       (name, serving_qty, serving_unit, carbs_g, protein_g, fat_g, kcal, source, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (name) DO UPDATE SET
       serving_qty  = EXCLUDED.serving_qty,
       serving_unit = EXCLUDED.serving_unit,
       carbs_g      = EXCLUDED.carbs_g,
       protein_g    = EXCLUDED.protein_g,
       fat_g        = EXCLUDED.fat_g,
       kcal         = EXCLUDED.kcal,
       source       = EXCLUDED.source,
       notes        = EXCLUDED.notes`,
    [
      f.name,
      f.servingQty,
      f.servingUnit,
      f.carbsG,
      f.proteinG,
      f.fatG,
      f.kcal,
      f.source ?? 'manual',
      f.notes ?? null,
    ],
  );
}

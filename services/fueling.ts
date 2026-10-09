import { query } from './db';
import {
  canonicalFuelingName,
  type FuelingProductSpec,
} from '../lib/fuelingCatalog';

// Fueling catalog + per-run/per-ride intake. Voice-note fueling items resolve against the
// `fueling_products` catalog by name; an unmatched product is flagged for a
// catalog add rather than silently dropped or auto-created (CLAUDE.md).

export interface FuelingProductMatch {
  id: string;
  name: string;
}

/**
 * Resolve a spoken product name to a catalog row, case-insensitively: an exact
 * name match first, then the catalog's explicit, athlete-confirmed aliases
 * (lib/fuelingCatalog.ts canonicalFuelingName — e.g. "honey salt water
 * solution" → Standard Fueling Solution). No open-ended fuzzy matching — that
 * would risk attributing sodium to the wrong product; unmatched names are
 * surfaced to the athlete instead.
 */
export async function findFuelingProductByName(
  name: string,
): Promise<FuelingProductMatch | null> {
  const lookup = async (n: string) => {
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM public.fueling_products
        WHERE lower(name) = lower($1)
        LIMIT 1`,
      [n],
    );
    return rows[0] ?? null;
  };
  const exact = await lookup(name);
  if (exact) return exact;
  const canonical = canonicalFuelingName(name);
  return canonical ? lookup(canonical) : null;
}

export interface RunFuelingItemInput {
  runId: string;
  productId: string;
  quantity: number; // servings, > 0
  timingKm: number | null;
  notes: string | null;
}

/** Insert one resolved fueling item for a run; returns the new row id. */
export async function insertRunFuelingItem(
  i: RunFuelingItemInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.run_fueling_items
       (run_id, product_id, quantity, timing_km, notes)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [i.runId, i.productId, i.quantity, i.timingKm, i.notes],
  );
  return rows[0]!.id;
}

export interface RideFuelingItemInput {
  rideId: string;
  productId: string;
  quantity: number; // servings, > 0
  timingKm: number | null;
  notes: string | null;
}

/** Insert one resolved fueling item for a ride (sibling to insertRunFuelingItem). */
export async function insertRideFuelingItem(
  i: RideFuelingItemInput,
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.ride_fueling_items
       (ride_id, product_id, quantity, timing_km, notes)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING id`,
    [i.rideId, i.productId, i.quantity, i.timingKm, i.notes],
  );
  return rows[0]!.id;
}

/**
 * Upsert a catalog product (idempotent on name). Used by the seed script — real
 * reference data, not per-run intake.
 */
export async function upsertFuelingProduct(
  p: FuelingProductSpec,
): Promise<void> {
  await query(
    `INSERT INTO public.fueling_products
       (name, category, serving_desc, water_ml, carbs_g, sodium_mg,
        potassium_mg, magnesium_mg, caffeine_mg, kcal, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (name) DO UPDATE SET
       category     = EXCLUDED.category,
       serving_desc = EXCLUDED.serving_desc,
       water_ml     = EXCLUDED.water_ml,
       carbs_g      = EXCLUDED.carbs_g,
       sodium_mg    = EXCLUDED.sodium_mg,
       potassium_mg = EXCLUDED.potassium_mg,
       magnesium_mg = EXCLUDED.magnesium_mg,
       caffeine_mg  = EXCLUDED.caffeine_mg,
       kcal         = EXCLUDED.kcal,
       notes        = EXCLUDED.notes`,
    [
      p.name,
      p.category,
      p.servingDesc,
      p.waterMl,
      p.carbsG,
      p.sodiumMg,
      p.potassiumMg,
      p.magnesiumMg,
      p.caffeineMg,
      p.kcal,
      p.notes ?? null,
    ],
  );
}

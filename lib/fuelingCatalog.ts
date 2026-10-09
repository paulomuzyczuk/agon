// Seed catalog of the athlete's actual on-run fueling products (Phase 2:
// "Seed fueling_products catalog"). Per-serving nutrient facts feed the
// fct_run_fueling mart (water/carbs/sodium balances). Pure data — the DB upsert
// lives in services/fueling.ts, seeded by scripts/seed-fueling.ts. This is REAL
// reference data (like lib/gear.ts SEED_GEAR); values are per one serving.
//
// Sources: manufacturer labels, rounded. Extend as new products are used — a
// voice note naming an unmatched product flags it for a catalog add here.

import {
  LONG_RUN_REMINDER_KM,
  FUELING_BASE_BOTTLES,
  FUELING_BOTTLE_STEP_KM,
} from './constants';

export type FuelingCategory =
  'water' | 'isotonic' | 'gel' | 'food' | 'salt_cap' | 'other';

export interface FuelingProductSpec {
  name: string;
  category: FuelingCategory;
  servingDesc: string;
  waterMl: number;
  carbsG: number;
  sodiumMg: number;
  potassiumMg: number;
  magnesiumMg: number;
  caffeineMg: number;
  kcal: number;
  notes?: string | null;
  /** Volume of one serving (ml) — lets a spoken "1.8 liters" become servings. */
  servingMl?: number;
  /** Mass of one serving (g) — lets a spoken "120 g" become servings. */
  servingG?: number;
}

export const SEED_FUELING_PRODUCTS: FuelingProductSpec[] = [
  {
    name: 'Water',
    category: 'water',
    servingDesc: '500 ml bottle',
    servingMl: 500,
    waterMl: 500,
    carbsG: 0,
    sodiumMg: 0,
    potassiumMg: 0,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 0,
  },
  {
    name: 'Powerade',
    category: 'isotonic',
    servingDesc: '500 ml bottle',
    servingMl: 500,
    waterMl: 500,
    carbsG: 19,
    sodiumMg: 225,
    potassiumMg: 55,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 80,
    notes: 'Mountain Blast, Brazil formulation (per 500 ml)',
  },
  {
    name: 'Gatorade',
    category: 'isotonic',
    servingDesc: '500 ml bottle',
    servingMl: 500,
    waterMl: 500,
    carbsG: 30,
    sodiumMg: 275,
    potassiumMg: 75,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 120,
  },
  {
    name: 'Gu Gel',
    category: 'gel',
    servingDesc: '1 sachet (32 g)',
    servingG: 32,
    waterMl: 0,
    carbsG: 22,
    sodiumMg: 60,
    potassiumMg: 40,
    magnesiumMg: 0,
    caffeineMg: 20,
    kcal: 100,
    notes: 'Caffeine varies by flavor; 20 mg is the standard caffeinated line',
  },
  {
    name: 'Banana',
    category: 'food',
    servingDesc: '1 medium (~120 g)',
    servingG: 120,
    waterMl: 0,
    carbsG: 27,
    sodiumMg: 1,
    potassiumMg: 420,
    magnesiumMg: 32,
    caffeineMg: 0,
    kcal: 105,
  },
  {
    name: 'Salt Cap',
    category: 'salt_cap',
    servingDesc: '1 capsule',
    waterMl: 0,
    carbsG: 0,
    sodiumMg: 300,
    potassiumMg: 21,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 0,
    notes: 'Generic electrolyte capsule (~300 mg sodium)',
  },
  {
    name: 'Honey',
    category: 'food',
    servingDesc: '1 tbsp (21 g)',
    servingG: 21,
    waterMl: 0,
    carbsG: 16,
    sodiumMg: 1,
    potassiumMg: 11,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 63,
    notes:
      'Standard honey macros (~304 kcal/100g); consistent with the Langnese Flotte Biene entry in lib/foodCatalog.ts',
  },
  {
    name: 'Standard Fueling Solution',
    category: 'isotonic',
    servingDesc: '1 bottle (450 ml water + 30 g honey + 1.2 g kitchen salt)',
    // A filled bottle holds ~500 ml (450 ml water + dissolved honey/salt); the
    // athlete counts "1 liter" as 2 bottles (lib/constants.ts calibration).
    servingMl: 500,
    waterMl: 450,
    carbsG: 23,
    sodiumMg: 473,
    potassiumMg: 16,
    magnesiumMg: 0,
    caffeineMg: 0,
    kcal: 90,
    notes:
      "Athlete's own homemade long-run mix. Macros scaled from this catalog's " +
      'Honey entry (30 g) plus 1.2 g kitchen salt (~39.3% sodium by mass = 472 mg); ' +
      'water contributes nothing.',
  },
];

// Athlete-confirmed synonyms (2026-09-24: "homemade mix = standard fueling
// solution — treat them as equals"). Voice notes describe the mix by its
// ingredients ("honey salt water solution", "water/salt/honey solution") rather
// than its catalog name. Deliberately an explicit, narrow list rather than
// fuzzy matching: a wrong match would put sodium on the wrong product. A rule
// matches when the spoken name contains every one of its words, in any order.
const FUELING_ALIASES: { canonical: string; allOf: string[] }[] = [
  { canonical: 'Standard Fueling Solution', allOf: ['honey', 'salt', 'water'] },
  { canonical: 'Standard Fueling Solution', allOf: ['homemade', 'mix'] },
  { canonical: 'Standard Fueling Solution', allOf: ['fueling', 'solution'] },
];

/**
 * The catalog name a spoken product refers to, or null. Tries, in order: the
 * name itself; the name with any parenthetical dropped ("water (1 liter)" →
 * Water); then the explicit alias rules above. Pure — the DB lookup lives in
 * services/fueling.ts.
 */
export function canonicalFuelingName(spoken: string): string | null {
  const byName = (n: string) =>
    SEED_FUELING_PRODUCTS.find((p) => p.name.toLowerCase() === n.toLowerCase())
      ?.name ?? null;
  const trimmed = spoken.trim();
  const stripped = trimmed
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const direct = byName(trimmed) ?? byName(stripped);
  if (direct) return direct;
  const words = new Set(stripped.toLowerCase().match(/[a-z]+/g) ?? []);
  const rule = FUELING_ALIASES.find((a) => a.allOf.every((w) => words.has(w)));
  return rule?.canonical ?? null;
}

/** Units a voice-note parse may report a fueling amount in. */
export type FuelingUnit = 'serving' | 'ml' | 'l' | 'g';

export interface SpokenFuelingAmount {
  /** The amount as spoken ("120" in "120 g of honey"), null if unstated. */
  amount?: number | null;
  unit?: FuelingUnit | null;
  /** Legacy parses (prompt v1) carried a servings count here instead. */
  quantity?: number | null;
}

/**
 * Convert a spoken fueling amount into catalog servings — the unit
 * run_fueling_items.quantity is stored in. The LLM reports the amount and unit
 * exactly as spoken; the arithmetic happens here, against the catalog's own
 * serving size, rather than asking the model to convert (it didn't: "120 g of
 * honey" was stored as 120 servings ≈ 2.5 kg). Returns null when the unit can't
 * be converted for this product (e.g. grams of a product with no servingG) — the
 * caller flags it rather than guessing. Nothing stated at all → 1 serving.
 */
export function fuelingServings(
  productName: string,
  spoken: SpokenFuelingAmount,
): number | null {
  const round = (n: number) => Math.round(n * 100) / 100;
  const amount = spoken.amount ?? null;
  if (amount == null || !(amount > 0)) {
    const legacy = spoken.quantity ?? null;
    return legacy != null && legacy > 0 ? legacy : 1;
  }
  const unit = spoken.unit ?? 'serving';
  if (unit === 'serving') return round(amount);
  const spec = SEED_FUELING_PRODUCTS.find(
    (p) => p.name.toLowerCase() === productName.toLowerCase(),
  );
  if (unit === 'ml' || unit === 'l') {
    const ml = unit === 'l' ? amount * 1000 : amount;
    return spec?.servingMl ? round(ml / spec.servingMl) : null;
  }
  return spec?.servingG ? round(amount / spec.servingG) : null;
}

export const STANDARD_FUELING_SOLUTION = SEED_FUELING_PRODUCTS.find(
  (p) => p.name === 'Standard Fueling Solution',
)!;

/** The composition parenthetical out of servingDesc, e.g. "450 ml water + 30 g honey + 1.2 g kitchen salt". */
const STANDARD_FUELING_RECIPE =
  /\(([^)]+)\)/.exec(STANDARD_FUELING_SOLUTION.servingDesc)?.[1] ??
  STANDARD_FUELING_SOLUTION.servingDesc;

export interface FuelingBottleEstimate {
  bottles: number;
  kcal: number;
  carbsG: number;
  sodiumMg: number;
  /** The bottle's composition, for display ("450 ml water + 30 g honey + 1.2 g kitchen salt"). */
  recipe: string;
}

/**
 * How many Standard Fueling Solution bottles a run of this distance calls for,
 * and their combined macros. Null below LONG_RUN_REMINDER_KM (no fueling
 * needed). Scales continuously rather than plateauing: FUELING_BASE_BOTTLES at
 * the threshold, one more every FUELING_BOTTLE_STEP_KM beyond it — see the
 * constants' own comment for the calibration against real reported intake.
 */
export function estimateFuelingBottles(
  distanceKm: number,
): FuelingBottleEstimate | null {
  if (distanceKm < LONG_RUN_REMINDER_KM) return null;
  const bottles =
    FUELING_BASE_BOTTLES +
    Math.floor((distanceKm - LONG_RUN_REMINDER_KM) / FUELING_BOTTLE_STEP_KM);
  const p = STANDARD_FUELING_SOLUTION;
  return {
    bottles,
    kcal: bottles * p.kcal,
    carbsG: bottles * p.carbsG,
    sodiumMg: bottles * p.sodiumMg,
    recipe: STANDARD_FUELING_RECIPE,
  };
}

// The athlete's own macro catalog — gathered by hand from REWE's website and
// other online product pages (source of truth the athlete trusts more than
// Cronometer's crowd-sourced entries; CLAUDE.md nutrition decision 2026-08-24).
// Each row is "per one serving" exactly like lib/fuelingCatalog.ts
// (SEED_FUELING_PRODUCTS) — serving_qty + serving_unit describe the serving the
// macros belong to, not a per-100g normalization, because that's how the
// athlete already thinks in quantities ("4 eggs", "2 portions of pasta").
// The DB upsert lives in services/foods.ts, seeded by scripts/seed-foods.ts.
// Source data: personal Google Sheet "Diets" → "Food Table" tab.

export interface FoodSpec {
  name: string;
  servingQty: number;
  servingUnit: string;
  carbsG: number;
  proteinG: number;
  fatG: number;
  kcal: number;
  source?: 'manual' | 'rewe';
  notes?: string | null;
}

export const SEED_FOODS: FoodSpec[] = [
  { name: 'egg', servingQty: 1, servingUnit: 'unit', carbsG: 0.5, proteinG: 6.0, fatG: 5.0, kcal: 71, source: 'rewe' },
  { name: 'wholemeal pasta', servingQty: 200, servingUnit: 'post-cook grams', carbsG: 64.0, proteinG: 13.0, fatG: 2.5, kcal: 331, source: 'rewe' },
  { name: 'wholemeal bread', servingQty: 100, servingUnit: 'g', carbsG: 21.0, proteinG: 5.0, fatG: 1.5, kcal: 118, source: 'rewe' },
  { name: 'rewe protein pudding', servingQty: 1, servingUnit: 'unit', carbsG: 8.4, proteinG: 20.0, fatG: 3.0, kcal: 141, source: 'rewe' },
  { name: 'koelln fruchte hafer muesli (ohne zuckerzusatz)', servingQty: 25, servingUnit: 'g', carbsG: 16.0, proteinG: 2.4, fatG: 1.5, kcal: 87, source: 'rewe' },
  { name: 'ja! Thunfischfilets in Sonnenblumenöl', servingQty: 1, servingUnit: 'can', carbsG: 0.6, proteinG: 33.6, fatG: 10.4, kcal: 230, source: 'rewe' },
  { name: 'King Cuisine Hummus', servingQty: 25, servingUnit: 'g', carbsG: 2.2, proteinG: 1.7, fatG: 7.2, kcal: 80, source: 'rewe' },
  { name: 'REWE Bio Körniger Frischkäse', servingQty: 50, servingUnit: 'g', carbsG: 0.3, proteinG: 3.2, fatG: 1.0, kcal: 23, source: 'rewe' },
  { name: 'Campo Verde Bio Demeter Feine Erbsen', servingQty: 1, servingUnit: 'unit', carbsG: 23.7, proteinG: 8.6, fatG: 0.5, kcal: 134, source: 'rewe' },
  { name: 'LikeMeat Like Grilled Chicken', servingQty: 1, servingUnit: 'unit', carbsG: 0.0, proteinG: 34.2, fatG: 5.2, kcal: 184, source: 'rewe' },
  { name: 'whey protein (concentrated)', servingQty: 31, servingUnit: 'g', carbsG: 1.6, proteinG: 24.0, fatG: 1.4, kcal: 115, source: 'manual' },
  { name: 'albumin', servingQty: 30, servingUnit: 'g', carbsG: 0.0, proteinG: 25.8, fatG: 0.0, kcal: 103, source: 'manual' },
  { name: 'ja! Fettarmer Joghurt mild 1,5%', servingQty: 100, servingUnit: 'g', carbsG: 6.3, proteinG: 5.2, fatG: 1.5, kcal: 60, source: 'rewe' },
  { name: 'apple', servingQty: 1, servingUnit: 'unit', carbsG: 21.0, proteinG: 0.2, fatG: 0.4, kcal: 88, source: 'manual' },
  { name: 'grapes', servingQty: 100, servingUnit: 'g', carbsG: 18.0, proteinG: 0.7, fatG: 0.2, kcal: 76, source: 'manual' },
  { name: 'foodspring Protein Bar (No Added Sugar)', servingQty: 1, servingUnit: 'unit', carbsG: 3.8, proteinG: 20.0, fatG: 0.0, kcal: 95, source: 'manual' },
  { name: 'Schwarzwaldmilch Protein H-Protein Milk 0.9%', servingQty: 100, servingUnit: 'ml', carbsG: 0.0, proteinG: 7.5, fatG: 0.9, kcal: 38, source: 'rewe' },
  { name: 'turkey breast', servingQty: 100, servingUnit: 'g', carbsG: 1.3, proteinG: 20.0, fatG: 1.0, kcal: 94, source: 'rewe' },
  { name: 'Orange + Lime Juice w/ Zero Tonic Water', servingQty: 200, servingUnit: 'ml', carbsG: 19.0, proteinG: 0.0, fatG: 0.0, kcal: 76, source: 'manual' },
  { name: 'Elinas Joghurt Griechischer Art Natur', servingQty: 150, servingUnit: 'g', carbsG: 5.9, proteinG: 5.0, fatG: 14.1, kcal: 170, source: 'rewe' },
  { name: 'KoRo Mandeln', servingQty: 30, servingUnit: 'g', carbsG: 2.7, proteinG: 6.4, fatG: 15.2, kcal: 173, source: 'rewe' },
  { name: 'Tafeltrauben hell kernlos', servingQty: 100, servingUnit: 'g', carbsG: 18.0, proteinG: 0.7, fatG: 0.2, kcal: 77, source: 'rewe' },
  { name: 'Deutsche See Lachsfilet 250g', servingQty: 100, servingUnit: 'g', carbsG: 0.0, proteinG: 20.2, fatG: 16.0, kcal: 225, source: 'rewe' },
  { name: 'Alpro Not Mlk Haferdrink', servingQty: 100, servingUnit: 'ml', carbsG: 5.7, proteinG: 0.7, fatG: 3.5, kcal: 57, source: 'rewe' },
  { name: 'REWE Beste Wahl Heidelbeeren', servingQty: 100, servingUnit: 'g', carbsG: 10.4, proteinG: 0.4, fatG: 0.3, kcal: 46, source: 'rewe' },
  { name: 'Luxardo Maraschino Cherries (1x Cherry)', servingQty: 5, servingUnit: 'g', carbsG: 4.0, proteinG: 0.0, fatG: 0.0, kcal: 16, source: 'manual' },
  { name: 'Organic Chia Seeds Mr. Brown', servingQty: 20, servingUnit: 'g', carbsG: 0.9, proteinG: 6.2, fatG: 4.2, kcal: 67, source: 'rewe' },
  { name: 'REWE Bio Creamy Erdnussbutter', servingQty: 50, servingUnit: 'g', carbsG: 8.0, proteinG: 13.5, fatG: 23.5, kcal: 298, source: 'rewe' },
  { name: 'REWE Bio Nuss-Mix geröstet & gesalzen', servingQty: 62.5, servingUnit: 'g', carbsG: 7.5, proteinG: 12.5, fatG: 34.4, kcal: 389, source: 'rewe' },
  { name: 'Olivas Anchoas', servingQty: 40, servingUnit: 'g', carbsG: 1.5, proteinG: 0.7, fatG: 6.4, kcal: 67, source: 'manual' },
  // Per-100g label: 21.5g fat / 0.08g carb / 1.3g protein. Athlete-set serving
  // size 33g (not the pack size) since this is eaten as an ad-hoc snack, not
  // part of any meal template — logged standalone via the /nutrition ad-hoc
  // food picker. 33g scaling: fat 7.1g, carb 0.03g, protein 0.4g, kcal from
  // macros (7.095*9 + 0.0264*4 + 0.429*4 = 65.68 -> 66).
  { name: 'REWE Beste Wahl Marinierte Oliven mit Knoblauch', servingQty: 33, servingUnit: 'g', carbsG: 0.03, proteinG: 0.4, fatG: 7.1, kcal: 66, source: 'rewe' },
  { name: 'Galbani Ricotta Cremosa', servingQty: 100, servingUnit: 'g', carbsG: 6.0, proteinG: 8.0, fatG: 12.0, kcal: 164, source: 'rewe' },
  { name: 'vly Erbsen-Drink High Protein vegan', servingQty: 100, servingUnit: 'ml', carbsG: 0.0, proteinG: 5.0, fatG: 1.8, kcal: 36, source: 'rewe' },
  { name: "Müller's Mühle Popcorn Mais", servingQty: 100, servingUnit: 'g', carbsG: 63.0, proteinG: 10.0, fatG: 3.3, kcal: 322, source: 'rewe' },
  { name: 'REWE Beste Wahl Sonnenblumenöl', servingQty: 100, servingUnit: 'ml', carbsG: 0.0, proteinG: 0.0, fatG: 92.0, kcal: 828, source: 'rewe' },
  { name: "Tony's Chocolonely Karamell Salz Vollmilch", servingQty: 100, servingUnit: 'g', carbsG: 54.0, proteinG: 7.0, fatG: 32.0, kcal: 532, source: 'rewe' },
  { name: 'Tafeltrauben blau kernlos', servingQty: 100, servingUnit: 'g', carbsG: 18.1, proteinG: 0.7, fatG: 0.2, kcal: 77, source: 'rewe' },
  { name: 'Baileys Original', servingQty: 50, servingUnit: 'ml', carbsG: 12.5, proteinG: 0.5, fatG: 6.5, kcal: 110, source: 'manual' },
  { name: 'Langnese Flotte Biene Wildblüten-Honig', servingQty: 5, servingUnit: 'g', carbsG: 3.8, proteinG: 0.0, fatG: 0.0, kcal: 15, source: 'rewe' },
  { name: 'REWE Bio Ahornsirup', servingQty: 100, servingUnit: 'ml', carbsG: 89.0, proteinG: 0.0, fatG: 0.0, kcal: 356, source: 'rewe' },
  // Not in the Food Table tab (referenced in meal plans with all-zero macros).
  { name: 'Coffee', servingQty: 1, servingUnit: 'cup', carbsG: 0, proteinG: 0, fatG: 0, kcal: 0, source: 'manual', notes: 'Black coffee, no sugar/milk' },
];

// Usual meals, seeded into `meal_templates`. Each template is a full day's
// eating grouped into meal slots; item quantities are in servings of the
// matching lib/foodCatalog.ts entry (by name — resolved to a food_id at seed
// time). The single template below is an illustrative example: replace it
// with your own days.
//
// The DB upsert lives in services/mealTemplates.ts, seeded by
// scripts/seed-meal-templates.ts.

export interface MealTemplateItemSpec {
  mealSlot: 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'post_workout' | 'other';
  food: string; // must match a lib/foodCatalog.ts SEED_FOODS[].name
  quantity: number; // servings
}

export interface MealTemplateSpec {
  name: string;
  context?: string | null;
  block?: number | null;
  notes?: string | null;
  items: MealTemplateItemSpec[];
}

export const SEED_MEAL_TEMPLATES: MealTemplateSpec[] = [
  {
    name: 'Example – Training Day',
    context: 'training_day',
    block: null,
    notes: 'Illustrative example template — replace with your own usual meals.',
    items: [
      { mealSlot: 'breakfast', food: 'egg', quantity: 3 },
      { mealSlot: 'breakfast', food: 'wholemeal bread', quantity: 2 },
      { mealSlot: 'breakfast', food: 'Coffee', quantity: 1 },
      { mealSlot: 'lunch', food: 'wholemeal pasta', quantity: 2 },
      { mealSlot: 'snack', food: 'apple', quantity: 1 },
      { mealSlot: 'post_workout', food: 'whey protein (concentrated)', quantity: 1 },
    ],
  },
];

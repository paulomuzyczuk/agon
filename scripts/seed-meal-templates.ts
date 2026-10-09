import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertMealTemplate } from '../services/mealTemplates';
import { SEED_MEAL_TEMPLATES } from '../lib/mealTemplates';
import { logger } from '../services/logger';

// Seed the athlete's usual meals (nutrition decision 2026-08-24), from the
// personal "Diets" Google Sheet. Requires `pnpm seed:foods` to have run first —
// each template item resolves against the foods catalog by name.
//
//   pnpm seed:meals

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-meal-templates');
  for (const t of SEED_MEAL_TEMPLATES) {
    await upsertMealTemplate(t);
  }
  logger.info('meal templates seeded', {
    job: 'seed-meal-templates',
    count: SEED_MEAL_TEMPLATES.length,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${SEED_MEAL_TEMPLATES.length} meal template(s): ` +
      `${SEED_MEAL_TEMPLATES.map((t) => t.name).join(', ')}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('seed-meal-templates failed', { job: 'seed-meal-templates' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertFood } from '../services/foods';
import { SEED_FOODS } from '../lib/foodCatalog';
import { logger } from '../services/logger';

// Seed the `foods` catalog (nutrition decision 2026-08-24) — the athlete's own
// macro data gathered from REWE + other online sources. Idempotent (upsert on
// name), so safe to re-run as lib/foodCatalog.ts grows.
//
//   pnpm seed:foods

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-foods');
  for (const f of SEED_FOODS) {
    await upsertFood(f);
  }
  logger.info('foods seeded', { job: 'seed-foods', count: SEED_FOODS.length });
  // eslint-disable-next-line no-console
  console.log(`\nSeeded ${SEED_FOODS.length} food(s).\n`);
}

main()
  .catch((err) => {
    logger.error('seed-foods failed', { job: 'seed-foods' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

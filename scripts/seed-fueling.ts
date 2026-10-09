import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertFuelingProduct } from '../services/fueling';
import { SEED_FUELING_PRODUCTS } from '../lib/fuelingCatalog';
import { logger } from '../services/logger';

// Seed the fueling_products catalog with the athlete's actual on-run products
// (Phase 2: "Seed fueling_products catalog"). Idempotent (upsert on name), so
// safe to re-run as products are added to lib/fuelingCatalog.ts.
//
//   pnpm seed:fueling
//
// Gated by the seed guard (assertLocalTarget) — run against a remote DB only with
// ALLOW_REMOTE_SEED=1.

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-fueling');
  for (const p of SEED_FUELING_PRODUCTS) {
    await upsertFuelingProduct(p);
  }
  logger.info('fueling products seeded', {
    job: 'seed-fueling',
    count: SEED_FUELING_PRODUCTS.length,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${SEED_FUELING_PRODUCTS.length} fueling product(s): ` +
      `${SEED_FUELING_PRODUCTS.map((p) => p.name).join(', ')}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('seed-fueling failed', { job: 'seed-fueling' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

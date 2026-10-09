import { loadEnv } from './loadEnv';
import { closeDbPool } from '../services/db';
import { upsertGear } from '../services/gear';
import { SEED_GEAR } from '../lib/gear';
import { logger } from '../services/logger';

// Reference-gear seed — REAL data, not dummy, so it is intentionally NOT gated by
// the local-only seed guard (cf. sihha's ensureDefaultInstitution). Populates the
// athlete's non-Strava gear (the HRMs) so the catalog + categories exist even
// before a Strava backfill. Idempotent — safe to re-run and safe against prod.
//
//   pnpm seed:gear
//
// Shoes come from Strava during the backfill and are not seeded here.

async function main(): Promise<void> {
  loadEnv();
  for (const g of SEED_GEAR) {
    await upsertGear({
      gear_id: g.gear_id,
      name: g.name,
      brand: g.brand,
      source: 'local',
      category: g.category,
    });
  }
  logger.info('gear seeded', { job: 'seed-gear', count: SEED_GEAR.length });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${SEED_GEAR.length} gear item(s): ${SEED_GEAR.map((g) => g.name).join(', ')}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('seed-gear failed', { job: 'seed-gear' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());

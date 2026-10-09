import { query } from './db';
import { localGearId, type GearCategory } from '../lib/gear';

// DB operations for the gear (shoe / HRM / watch / ...) catalog and the run_gear
// join. Source-agnostic: Strava gear and manually-seeded gear both land here so
// per-item usage aggregates across sources. See
// migrations/20260723003000_gear.sql and _004000_gear_categories_and_run_gear.sql.

export type GearSource = 'strava' | 'local';

export interface GearRow {
  gear_id: string;
  name: string;
  source: GearSource;
  category: GearCategory;
  brand?: string | null;
}

/** Upsert a gear row keyed on its id (Strava backfill + reference seed). */
export async function upsertGear(gear: GearRow): Promise<GearRow> {
  await query(
    `INSERT INTO public.gear (gear_id, name, source, category, brand)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (gear_id) DO UPDATE SET
       name     = EXCLUDED.name,
       source   = EXCLUDED.source,
       category = EXCLUDED.category,
       brand    = COALESCE(EXCLUDED.brand, public.gear.brand)`,
    [gear.gear_id, gear.name, gear.source, gear.category, gear.brand ?? null],
  );
  return gear;
}

/** Idempotently link a gear item to a run. */
export async function linkRunGear(
  runId: string,
  gearId: string,
): Promise<void> {
  await query(
    `INSERT INTO public.run_gear (run_id, gear_id)
     VALUES ($1, $2)
     ON CONFLICT (run_id, gear_id) DO NOTHING`,
    [runId, gearId],
  );
}

/** Idempotently link a gear item to a ride (mirrors linkRunGear). */
export async function linkRideGear(
  rideId: string,
  gearId: string,
): Promise<void> {
  await query(
    `INSERT INTO public.ride_gear (ride_id, gear_id)
     VALUES ($1, $2)
     ON CONFLICT (ride_id, gear_id) DO NOTHING`,
    [rideId, gearId],
  );
}

/**
 * Resolve a gear item known only by NAME (no Strava id) to a stable gear_id,
 * minting a 'local:' row on first sight. Reuses an existing row for the same
 * name — including a Strava-sourced one — so an item is matched, not duplicated.
 * Entry point for the voice-note / manual capture pipeline.
 */
export async function resolveLocalGear(
  name: string,
  category: GearCategory,
): Promise<string> {
  const existing = await query<{ gear_id: string }>(
    'SELECT gear_id FROM public.gear WHERE lower(name) = lower($1)',
    [name],
  );
  const found = existing.rows[0];
  if (found) return found.gear_id;

  const gearId = localGearId(name);
  await query(
    `INSERT INTO public.gear (gear_id, name, source, category)
     VALUES ($1, $2, 'local', $3)
     ON CONFLICT (gear_id) DO NOTHING`,
    [gearId, name, category],
  );
  return gearId;
}

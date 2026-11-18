import { query } from './db';
import { localGearId, type GearCategory } from '../lib/gear';
import type { RunShoe } from '../lib/runShoes';

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

/**
 * Active running shoes, most recently used first (so the first is the natural
 * default, as in Strava). Retired shoes are left out of the picker.
 */
export async function listRunShoes(): Promise<RunShoe[]> {
  const { rows } = await query<{
    gear_id: string;
    name: string;
    last_used_at: Date | null;
  }>(
    `SELECT g.gear_id, g.name,
            (SELECT max(r.started_at)
               FROM public.run_gear rg JOIN public.runs r ON r.id = rg.run_id
              WHERE rg.gear_id = g.gear_id) AS last_used_at
       FROM public.gear g
      WHERE g.category = 'shoe' AND NOT g.retired
      ORDER BY last_used_at DESC NULLS LAST, g.name`,
  );
  return rows.map((r) => ({
    gearId: r.gear_id,
    name: r.name,
    lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
  }));
}

/** A registered shoe by id, or null (unknown id, or not a shoe). */
export async function findShoe(
  gearId: string,
): Promise<{ gearId: string; name: string } | null> {
  const { rows } = await query<{ gear_id: string; name: string }>(
    `SELECT gear_id, name FROM public.gear
      WHERE gear_id = $1 AND category = 'shoe'`,
    [gearId],
  );
  const row = rows[0];
  return row ? { gearId: row.gear_id, name: row.name } : null;
}

/**
 * Make `gearId` THE shoe of a run: drop any other shoe link first, so a retried
 * save with a corrected choice (or a shoe merged in from a Strava twin) never
 * leaves two shoes on one run. Other gear (the HRM) is untouched.
 */
export async function setRunShoe(runId: string, gearId: string): Promise<void> {
  await query(
    `DELETE FROM public.run_gear rg USING public.gear g
      WHERE rg.run_id = $1 AND g.gear_id = rg.gear_id
        AND g.category = 'shoe' AND rg.gear_id <> $2`,
    [runId, gearId],
  );
  await linkRunGear(runId, gearId);
}

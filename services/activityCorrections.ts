import type { PoolClient } from 'pg';
import { query } from './db';
import { RIDE_POWER_FIELDS } from '../lib/ridePower';

// Hand corrections that survive a source re-sync (2026-09-30). The athlete
// sometimes starts/stops Strava late (forgot to press start, left it running
// at home) and corrects the activity's distance/duration by hand. The source
// upserts (services/strava/ingest.ts upsertRun, services/strava/rideIngest.ts
// upsertRide — shared by Strava, Google Health, file import and live
// recording) used to overwrite every summary column on conflict, so a backfill
// re-run silently reverted those corrections.
//
// `runs.corrected_fields` / `rides.corrected_fields` list the columns the
// athlete corrected; the upserts keep the stored value for each one instead of
// the source's. Same "human beats machine" rule as lib/sync/mergeField.ts,
// scoped to the ingest-owned columns — runs/rides are not replicated sync
// tables.

/** Columns the run upsert owns (overwrites on conflict unless corrected). */
export const SOURCE_OWNED_RUN_COLUMNS = [
  'date',
  'started_at',
  'start_lat',
  'start_lng',
  'block',
  'week',
  'distance_km',
  'duration_s',
  'avg_hr',
  'max_hr',
  'avg_pace_s_per_km',
  'elevation_gain_m',
  'shoe_used',
  'strava_activity_id',
  'origin',
] as const;

/** Columns the ride upsert owns (overwrites on conflict unless corrected). */
export const SOURCE_OWNED_RIDE_COLUMNS = [
  'date',
  'started_at',
  'start_lat',
  'start_lng',
  'block',
  'week',
  'distance_km',
  'duration_s',
  'avg_hr',
  'max_hr',
  'avg_speed_kmh',
  'max_speed_kmh',
  'elevation_gain_m',
  'bike_used',
  'origin',
  // Power (MZY-267) — corrected as one group, see correctedPredicate.
  'avg_power_w',
  'max_power_w',
  'weighted_avg_power_w',
  'kilojoules',
  'power_source',
] as const;

export type SourceOwnedRunColumn = (typeof SOURCE_OWNED_RUN_COLUMNS)[number];
export type SourceOwnedRideColumn = (typeof SOURCE_OWNED_RIDE_COLUMNS)[number];

const COLUMNS = {
  runs: SOURCE_OWNED_RUN_COLUMNS,
  rides: SOURCE_OWNED_RIDE_COLUMNS,
} as const;

/**
 * The ride power columns are corrected as ONE group (MZY-267): if the athlete
 * corrected any of them, the source keeps none of them. Otherwise a re-sync
 * could set a Strava-estimated kJ beside a hand-entered avg W, all under the
 * 'manual' label — a provenance lie.
 */
const RIDE_POWER_COLUMNS: readonly SourceOwnedRideColumn[] = RIDE_POWER_FIELDS;

const RIDE_POWER_ARRAY_SQL = `ARRAY[${RIDE_POWER_COLUMNS.map((c) => `'${c}'`).join(',')}]::text[]`;

/** SQL predicate: is column `c` of `table` hand-corrected (power: as a group)? */
function correctedPredicate(table: 'runs' | 'rides', c: string): string {
  if (
    table === 'rides' &&
    (RIDE_POWER_COLUMNS as readonly string[]).includes(c)
  ) {
    return `${table}.corrected_fields && ${RIDE_POWER_ARRAY_SQL}`;
  }
  return `'${c}' = ANY(${table}.corrected_fields)`;
}

/**
 * The `ON CONFLICT ... DO UPDATE SET` body for a source upsert: each owned
 * column takes the incoming value unless it's listed in corrected_fields
 * (ride power columns: unless any of them is).
 */
export function upsertSetKeepingCorrections(table: 'runs' | 'rides'): string {
  return COLUMNS[table]
    .map(
      (c) =>
        `${c} = CASE WHEN ${correctedPredicate(table, c)} ` +
        `THEN ${table}.${c} ELSE EXCLUDED.${c} END`,
    )
    .join(',\n       ');
}

/** Anything with pg's query() — the pool helper or a transaction's client. */
export type Queryable = Pick<PoolClient, 'query'>;

const pooled: Queryable = { query: query as Queryable['query'] };

async function correct(
  table: 'runs' | 'rides',
  id: string,
  patch: Record<string, unknown>,
  db: Queryable,
): Promise<void> {
  const owned: readonly string[] = COLUMNS[table];
  const cols = Object.keys(patch).filter((c) => owned.includes(c));
  if (cols.length === 0) return;
  const sets = cols.map((c, i) => `${c} = $${i + 3}`);
  // Moving started_at (a missed-start correction, MZY-253) stashes the
  // source's start the first time, so stream time and source-overlap
  // matching keep the source's clock (migrations/20260930020000).
  const stash = cols.includes('started_at')
    ? `source_started_at = COALESCE(source_started_at, started_at),`
    : '';
  await db.query(
    `UPDATE public.${table}
        SET ${stash}
            ${sets.join(', ')},
            corrected_fields = ARRAY(
              SELECT DISTINCT unnest(corrected_fields || $2::text[]) ORDER BY 1)
      WHERE id = $1`,
    [id, cols, ...cols.map((c) => patch[c])],
  );
}

/**
 * Hand-correct a run's source-owned columns and record them in
 * corrected_fields, so a later re-sync keeps them. Passing a column with its
 * current value just marks it corrected. Non-owned keys are ignored. Pass a
 * transaction client as `db` to write inside a transaction.
 */
export function correctRun(
  runId: string,
  patch: Partial<Record<SourceOwnedRunColumn, unknown>>,
  db: Queryable = pooled,
): Promise<void> {
  return correct('runs', runId, patch, db);
}

const RIDE_POWER_VALUE_COLUMNS = RIDE_POWER_COLUMNS.filter(
  (c) => c !== 'power_source',
);

/**
 * Ride counterpart of correctRun. A hand-entered watt value is 'manual' power:
 * when the patch touches a power value without saying where it came from,
 * power_source is set (and marked corrected) as 'manual', so a later re-sync
 * can't relabel the athlete's number as a source's estimate.
 */
export function correctRide(
  rideId: string,
  patch: Partial<Record<SourceOwnedRideColumn, unknown>>,
  db: Queryable = pooled,
): Promise<void> {
  const touchesPower = RIDE_POWER_VALUE_COLUMNS.some((c) => c in patch);
  const withSource =
    touchesPower && !('power_source' in patch)
      ? { ...patch, power_source: 'manual' }
      : patch;
  return correct('rides', rideId, withSource, db);
}

/**
 * Hand the given columns back to the source: drop them from corrected_fields
 * so the next re-sync takes the source's value again. started_at is restored
 * right away from source_started_at (exact — no re-sync needed). Returns the
 * columns actually reverted. A stream trim is not undone: a stored stream is
 * never re-fetched.
 */
export async function revertCorrections(
  table: 'runs' | 'rides',
  id: string,
  fields: readonly string[],
  db: Queryable = pooled,
): Promise<string[]> {
  const owned: readonly string[] = COLUMNS[table];
  const cols = fields.filter((c) => owned.includes(c));
  if (cols.length === 0) return [];
  const { rows } = await db.query<{ reverted: string[] }>(
    `WITH prev AS (
       SELECT id, corrected_fields AS before
         FROM public.${table} WHERE id = $1 FOR UPDATE)
     UPDATE public.${table} t
        SET corrected_fields = ARRAY(
              SELECT unnest(t.corrected_fields) EXCEPT SELECT unnest($2::text[])
              ORDER BY 1),
            started_at = CASE WHEN 'started_at' = ANY($2::text[])
                                   AND t.source_started_at IS NOT NULL
                              THEN t.source_started_at ELSE t.started_at END,
            source_started_at = CASE WHEN 'started_at' = ANY($2::text[])
                                     THEN NULL ELSE t.source_started_at END
       FROM prev
      WHERE t.id = prev.id
      RETURNING ARRAY(SELECT unnest(prev.before) INTERSECT SELECT unnest($2::text[])
                      ORDER BY 1) AS reverted`,
    [id, cols],
  );
  return rows[0]?.reverted ?? [];
}

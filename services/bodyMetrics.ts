import { query } from './db';

// Storage for body-composition measurements (weight, body-fat %). No UNIQUE on
// date — the schema allows multiple weigh-ins per day (morning/evening). Written
// by the /weight and /bf Telegram commands and by body voice notes.

export interface BodyMetricRecord {
  date: string; // YYYY-MM-DD
  weightKg: number | null;
  bodyFatPct: number | null;
  notes: string | null;
}

/** Insert a body-metrics row; returns the new row id. */
export async function insertBodyMetric(r: BodyMetricRecord): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.body_metrics (date, weight_kg, body_fat_pct, notes)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [r.date, r.weightKg, r.bodyFatPct, r.notes],
  );
  return rows[0]!.id;
}

/** A body-metrics row pulled from an external source (e.g. Google Health). */
export interface SourcedBodyMetricRecord {
  date: string; // YYYY-MM-DD, athlete-local
  source: string; // e.g. 'google_health'
  externalId: string;
  weightKg: number | null;
  bodyFatPct: number | null;
}

/**
 * Idempotent upsert keyed on (source, external_id) — the partial unique index
 * from migration 20260925010000. A re-sync overwrites the values in place.
 */
export async function upsertSourcedBodyMetric(
  r: SourcedBodyMetricRecord,
): Promise<void> {
  await query(
    `INSERT INTO public.body_metrics
       (date, weight_kg, body_fat_pct, source, external_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET date         = EXCLUDED.date,
                   weight_kg    = EXCLUDED.weight_kg,
                   body_fat_pct = EXCLUDED.body_fat_pct`,
    [r.date, r.weightKg, r.bodyFatPct, r.source, r.externalId],
  );
}

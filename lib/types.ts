import type { DataSource } from './constants';

// Shared domain types. Hand-kept to mirror the migration DDL (migrations are the
// single source of truth; these are the TypeScript view of the columns the
// ingestion layer writes). Nullable columns that a later milestone fills
// (weather enrichment, voice-note qualitative fields) are `| null` here.

/**
 * A row destined for the `runs` table. `id` and DB defaults are omitted — they
 * are assigned by Postgres. The idempotency key is `(source, external_id)`;
 * `strava_activity_id` is retained (Strava-only, being phased out) until a later
 * CONTRACT migration drops it.
 */
export interface RunRecord {
  date: string; // YYYY-MM-DD (local)
  started_at: string | null; // ISO 8601 UTC instant of the run start
  start_lat: number | null; // start GPS (Strava start_latlng)
  start_lng: number | null;
  block: number | null;
  week: number | null;
  distance_km: number;
  duration_s: number;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace_s_per_km: number | null;
  elevation_gain_m: number | null;
  shoe_used: string | null; // denormalized shoe name; structured gear lives in run_gear
  fueling: string | null; // raw voice-note text; structured intake lives in run_fueling_items
  perceived_effort: number | null;
  pain_location: string | null;
  pain_onset_km: number | null;
  general_notes: string | null;
  strava_activity_id: number | null;
  // Source-agnostic idempotency key (with `source`): the provider's own id for
  // this activity — the Strava activity id as text, the Google Health dataPoint
  // id, or a deterministic file hash for imports. Null for manual runs.
  external_id: string | null;
  source: DataSource;
  // Upstream platform within `source` (e.g. google_health → 'health_connect' |
  // 'fitbit'). Drives dedupe (prefer SOT-accurate health_connect) + analytics
  // weighting. Null for sources that don't distinguish an upstream platform.
  origin: string | null;
  // Weather enrichment (Open-Meteo) — populated by a later milestone's job.
  temp_c: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  weather_conditions: string | null;
}

/** Where a ride's watts came from: a power meter, a source's model, or by hand. */
export type PowerSource = 'device' | 'estimated' | 'manual';

/** The power columns of a ride (migrations/20261004000000_ride_power.sql). */
export type RidePowerFields = Pick<
  RideRecord,
  | 'avg_power_w'
  | 'max_power_w'
  | 'weighted_avg_power_w'
  | 'kilojoules'
  | 'power_source'
>;

/** The power fields of a RideRecord, all empty — for sources with no watts. */
export const NO_RIDE_POWER = {
  avg_power_w: null,
  max_power_w: null,
  weighted_avg_power_w: null,
  kilojoules: null,
  power_source: null,
} as const satisfies RidePowerFields;

/**
 * A row destined for the `rides` table. Mirrors RunRecord — same idempotency
 * key `(source, external_id)`, same weather/qualitative shape — but speed
 * instead of pace, and no pain/shoe fields (bikes use `bike_used`).
 */
export interface RideRecord {
  date: string; // YYYY-MM-DD (local)
  started_at: string | null; // ISO 8601 UTC instant of the ride start
  start_lat: number | null;
  start_lng: number | null;
  block: number | null;
  week: number | null;
  distance_km: number;
  duration_s: number;
  avg_hr: number | null;
  max_hr: number | null;
  avg_speed_kmh: number | null;
  max_speed_kmh: number | null;
  elevation_gain_m: number | null;
  bike_used: string | null; // denormalized bike name; structured gear lives in ride_gear
  // Power, with provenance (migrations/20261004000000_ride_power.sql). All
  // null with power_source null when the source had no watts. Only 'device'
  // power may feed NP/IF/TSS/curves — never 'estimated' or 'manual'.
  avg_power_w: number | null;
  max_power_w: number | null;
  weighted_avg_power_w: number | null; // the source's NP-like figure, not Agon's NP
  kilojoules: number | null;
  power_source: PowerSource | null;
  perceived_effort: number | null;
  general_notes: string | null;
  external_id: string | null;
  source: DataSource;
  origin: string | null;
  temp_c: number | null;
  humidity_pct: number | null;
  wind_kph: number | null;
  weather_conditions: string | null;
}

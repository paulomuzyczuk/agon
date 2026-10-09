import { query } from './db';
import { computeBlockWeek } from '../lib/training/trainingBlocks';

// Read/write helpers for the `runs` table used by the voice-note run path. Runs
// are normally created by the Strava backfill; a post-run voice note enriches the
// matching row with qualitative fields. When no run exists for the date yet (the
// note beat the Strava sync, or the run was never on Strava) and a distance was
// spoken, we create a minimal manual run so fueling has something to attach to.

export interface RunMatch {
  id: string;
  date: string; // YYYY-MM-DD
}

/**
 * The run to attribute a voice note to: the latest run on `date`. Latest (by
 * started_at, then created_at) handles the rare two-runs-in-a-day case by taking
 * the most recent, which is the one just finished when the note is recorded.
 */
export async function findLatestRunOnDate(
  date: string,
): Promise<RunMatch | null> {
  const { rows } = await query<{ id: string; date: string }>(
    `SELECT id, to_char(date, 'YYYY-MM-DD') AS date
       FROM public.runs
      WHERE date = $1
      ORDER BY started_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [date],
  );
  return rows[0] ?? null;
}

export interface RunQualitativeFields {
  fueling: string | null; // raw voice-note text
  perceivedEffort: number | null;
  painLocation: string | null;
  painOnsetKm: number | null;
  generalNotes: string | null;
  shoeUsed: string | null;
}

/**
 * Patch a run's qualitative columns. A note that mentions pain but not effort
 * must not wipe an effort set elsewhere, so a null incoming field never erases
 * an existing value.
 *
 * The free-text fields (fueling/pain_location/general_notes) APPEND rather than
 * replace: a day can get more than one voice note about the same run (e.g. the
 * run itself, then a separate post-run fueling note), and each one's content is
 * real information the next one must not silently erase. Found live 2026-08-25:
 * a second same-day note's general_notes had overwritten the first note's
 * account of the run entirely. The scalar fields (perceived_effort/
 * pain_onset_km/shoe_used) still overwrite — "most recent wins" is the sane
 * default for a single number, and appending doesn't make sense there.
 * pain_location skips appending an exact repeat (the same location mentioned
 * twice shouldn't duplicate in the text).
 */
export async function updateRunQualitative(
  runId: string,
  f: RunQualitativeFields,
): Promise<void> {
  await query(
    `UPDATE public.runs SET
       fueling          = CASE
                             WHEN $2::text IS NULL THEN fueling
                             WHEN fueling IS NULL OR fueling = '' THEN $2
                             ELSE fueling || ' | ' || $2
                           END,
       perceived_effort = COALESCE($3, perceived_effort),
       pain_location    = CASE
                             WHEN $4::text IS NULL THEN pain_location
                             WHEN pain_location IS NULL OR pain_location = '' THEN $4
                             WHEN pain_location = $4 THEN pain_location
                             ELSE pain_location || ' | ' || $4
                           END,
       pain_onset_km    = COALESCE($5, pain_onset_km),
       general_notes    = CASE
                             WHEN $6::text IS NULL THEN general_notes
                             WHEN general_notes IS NULL OR general_notes = '' THEN $6
                             ELSE general_notes || ' | ' || $6
                           END,
       shoe_used        = COALESCE($7, shoe_used)
     WHERE id = $1`,
    [
      runId,
      f.fueling,
      f.perceivedEffort,
      f.painLocation,
      f.painOnsetKm,
      f.generalNotes,
      f.shoeUsed,
    ],
  );
}

/**
 * Seed a run's start coordinates without clobbering values already set. Used by
 * the Google Health ingest: a run's GPS start lives in the route (TCX), not the
 * session summary, so it's patched in after the streams pass resolves the first
 * route point. COALESCE keeps any existing coordinates (e.g. a Strava start).
 */
export async function updateRunStartGps(
  runId: string,
  lat: number | null,
  lng: number | null,
): Promise<void> {
  if (lat == null || lng == null) return;
  await query(
    `UPDATE public.runs
        SET start_lat = COALESCE(start_lat, $2),
            start_lng = COALESCE(start_lng, $3)
      WHERE id = $1`,
    [runId, lat, lng],
  );
}

/**
 * FILL a run's avg/max HR without clobbering values it already has (COALESCE).
 * Used by the Google Health ingest to add Fitbit wrist HR to a run whose SOT
 * record carried no HR — a chest-strap HR from the SOT is preserved. No-op when
 * both inputs are null.
 */
export async function updateRunHr(
  runId: string,
  avgHr: number | null,
  maxHr: number | null,
): Promise<void> {
  if (avgHr == null && maxHr == null) return;
  await query(
    `UPDATE public.runs
        SET avg_hr = COALESCE(avg_hr, $2),
            max_hr = COALESCE(max_hr, $3)
      WHERE id = $1`,
    [runId, avgHr, maxHr],
  );
}

/**
 * FILL a run's elevation gain without clobbering a value it already has
 * (COALESCE). Used by the Strava match-and-enrich pass: the Fitbit-Air-sourced
 * google_health runs carry no elevation, so a matched Strava activity's
 * total_elevation_gain fills the gap; a run that already has elevation is left
 * untouched. No-op when the input is null.
 */
export async function updateRunElevationGain(
  runId: string,
  elevationGainM: number | null,
): Promise<void> {
  if (elevationGainM == null) return;
  await query(
    `UPDATE public.runs
        SET elevation_gain_m = COALESCE(elevation_gain_m, $2)
      WHERE id = $1`,
    [runId, elevationGainM],
  );
}

export interface ManualRunInput {
  date: string; // YYYY-MM-DD
  distanceKm: number; // > 0 (runs.distance_km is NOT NULL and CHECK > 0)
  durationS?: number | null;
}

/**
 * Insert a minimal manual run (source 'telegram') so a voice note with no
 * Strava-backed run still has a row to enrich. duration_s is NOT NULL/CHECK > 0,
 * so it defaults to 1 when unknown — a placeholder the real Strava sync can later
 * correct; the qualitative data is the point here, not the metrics.
 */
export async function insertManualRun(input: ManualRunInput): Promise<string> {
  const { block, week } = computeBlockWeek(input.date);
  const durationS =
    input.durationS && input.durationS > 0 ? input.durationS : 1;
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.runs
       (date, block, week, distance_km, duration_s, source)
     VALUES ($1,$2,$3,$4,$5,'telegram')
     RETURNING id`,
    [input.date, block, week, input.distanceKm, durationS],
  );
  return rows[0]!.id;
}

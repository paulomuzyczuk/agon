import { query } from './db';

// Read/write helpers for the `rides` table. Mirrors the GPS/HR-fill helpers in
// services/runs.ts (updateRunStartGps/updateRunHr) used by the Google Health
// ingest. Qualitative capture (voice-note ride logging) is out of scope for
// v1 — see Linear — so this file only carries what the ingest adapters need.
// Hand corrections: services/activityCorrections.ts.

/**
 * Seed a ride's start coordinates without clobbering values already set. Used
 * by the Google Health ingest: a ride's GPS start lives in the route (TCX),
 * not the session summary, so it's patched in after the streams pass resolves
 * the first route point. COALESCE keeps any existing coordinates (e.g. a
 * Strava start). Mirrors services/runs.ts updateRunStartGps.
 */
export async function updateRideStartGps(
  rideId: string,
  lat: number | null,
  lng: number | null,
): Promise<void> {
  if (lat == null || lng == null) return;
  await query(
    `UPDATE public.rides
        SET start_lat = COALESCE(start_lat, $2),
            start_lng = COALESCE(start_lng, $3)
      WHERE id = $1`,
    [rideId, lat, lng],
  );
}

/**
 * FILL a ride's avg/max HR without clobbering values it already has
 * (COALESCE). Mirrors services/runs.ts updateRunHr. No-op when both inputs
 * are null.
 */
export async function updateRideHr(
  rideId: string,
  avgHr: number | null,
  maxHr: number | null,
): Promise<void> {
  if (avgHr == null && maxHr == null) return;
  await query(
    `UPDATE public.rides
        SET avg_hr = COALESCE(avg_hr, $2),
            max_hr = COALESCE(max_hr, $3)
      WHERE id = $1`,
    [rideId, avgHr, maxHr],
  );
}

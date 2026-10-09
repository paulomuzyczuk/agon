import { z } from 'zod';

// Zod schemas for the slice of the Strava API v3 we consume. Validation happens
// at the network boundary (sihha convention: never trust an external payload) —
// every response is parsed through these before any mapping. Unknown fields are
// stripped by default, which is what we want: Strava returns dozens of columns
// we don't model.

// POST https://www.strava.com/oauth/token response (auth-code exchange AND
// refresh). `athlete` is present only on the initial authorization-code
// exchange, never on a refresh — hence optional.
export const stravaTokenResponseSchema = z.object({
  token_type: z.string(),
  access_token: z.string(),
  refresh_token: z.string(),
  expires_at: z.number().int(), // absolute expiry, UNIX seconds
  expires_in: z.number().int(), // seconds until expiry
  scope: z.string().optional(),
  athlete: z.object({ id: z.number().int() }).passthrough().optional(),
});
export type StravaTokenResponse = z.infer<typeof stravaTokenResponseSchema>;

// GET /athlete/activities — summary activity. HR fields are absent when the
// activity has no HR stream (or the athlete hides it), so they're optional.
export const stravaSummaryActivitySchema = z.object({
  id: z.number().int(),
  name: z.string().optional(),
  distance: z.number().nonnegative(), // metres
  moving_time: z.number().int().nonnegative(), // seconds
  elapsed_time: z.number().int().nonnegative(), // seconds
  total_elevation_gain: z.number().optional(), // metres
  type: z.string().optional(), // legacy activity type
  sport_type: z.string().optional(), // preferred activity type
  start_date: z.string(), // UTC ISO 8601
  start_date_local: z.string(), // athlete-local ISO 8601
  average_heartrate: z.number().optional(),
  max_heartrate: z.number().optional(),
  average_speed: z.number().optional(), // m/s — bikes only (runs use moving_time/distance for pace)
  max_speed: z.number().optional(), // m/s
  gear_id: z.string().nullable().optional(),
  start_latlng: z.array(z.number()).nullable().optional(), // [lat, lng] or [] when GPS-less
  device_name: z.string().nullable().optional(), // recording device, e.g. "Strava App"
  // Power (rides). Strava fills average_watts/kilojoules even with NO power
  // meter — its own estimate — and says which via device_watts (true only
  // when a meter measured it). weighted_average_watts/max_watts are
  // documented as meter-only. See services/strava/mapper.ts powerFields.
  average_watts: z.number().nonnegative().optional(),
  weighted_average_watts: z.number().nonnegative().optional(),
  max_watts: z.number().nonnegative().optional(),
  kilojoules: z.number().nonnegative().optional(),
  device_watts: z.boolean().optional(),
});
export type StravaSummaryActivity = z.infer<typeof stravaSummaryActivitySchema>;

export const stravaActivityListSchema = z.array(stravaSummaryActivitySchema);

// GET /gear/{id} — only the name is needed to resolve gear_id -> shoe_used.
export const stravaGearSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type StravaGear = z.infer<typeof stravaGearSchema>;

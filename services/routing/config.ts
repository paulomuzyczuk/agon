import type { Coord } from './types';

// Athlete's home location (AGON_HOME_LAT/LNG) — geocoded once from the home
// address via the ORS geocoder and pinned in .env.local, so "run 25 km from
// home" needs no coordinates. Also the weather fallback for GPS-less activities
// (services/weather/enrich.ts, MZY-226) — one source of truth for "home". Kept
// out of the repo (a home address is PII): env only, no committed default.

/** Home from env, or null when unset — for callers that can do without it. */
export function homeLocationOrNull(): Coord | null {
  const rawLat = process.env.AGON_HOME_LAT;
  const rawLng = process.env.AGON_HOME_LNG;
  if (!rawLat || !rawLng) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export function homeLocation(): Coord {
  const home = homeLocationOrNull();
  if (!home) {
    throw new Error(
      'routing: AGON_HOME_LAT and AGON_HOME_LNG must be set (decimal degrees) ' +
        'to use the default start location',
    );
  }
  return home;
}

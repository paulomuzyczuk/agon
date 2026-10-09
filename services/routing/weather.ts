// Weather awareness for route ranking (CLAUDE.md Premium-Parity #6 follow-up
// "weather-weighted ranking (wind/heat)"). Two very different roles for the SAME
// forecast, deliberately treated differently:
//
//   - WIND varies BY ROUTE: each candidate loop heads a different overall
//     direction (its "apex bearing" — the same concept diversity.ts uses for
//     directional spread), so headwind-vs-tailwind exposure actually
//     DISCRIMINATES between candidates. It's folded into rank.ts as a tiebreak.
//   - HEAT does NOT vary by route: every candidate from one suggestRoutes() call
//     shares the same start location/time, hence the same forecast temperature.
//     Adding a constant to every candidate's score changes nothing about their
//     relative order — heat literally CANNOT be a ranking factor here, only a
//     DISPLAYED caveat (mirrors elevation.ts's SRTM caveat: real information,
//     but not something ranking can act on).
//
// Coarse by design, like elevation.ts's ascent figures: a loop's "apex bearing"
// is one number standing in for a route that actually faces many directions over
// its length, and the forecast is one reading for the whole route's duration,
// not a minute-by-minute one. Good enough to compare candidates against each
// other; not a precise physical model. Pure + unit-tested — no network calls
// here, the caller (generate.ts) fetches the forecast and passes it in.

export interface RouteForecast {
  tempC: number | null;
  windKph: number | null;
  /** Meteorological convention: the direction the wind is blowing FROM. */
  windFromDeg: number | null;
}

/** Smallest angle between two bearings (0–180), degrees. */
function angularDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const toRad = (d: number): number => (d * Math.PI) / 180;

/**
 * Headwind exposure penalty for a route heading `bearingDeg`, given the day's
 * forecast wind. Zero when there's no forecast/wind data, or the wind is a
 * crosswind/tailwind (≥90° off the route's outbound heading); scales up to the
 * full forecast wind speed (km/h) for a dead-on headwind (0° — heading straight
 * into it). Deliberately PENALTY-ONLY, never a bonus for a tailwind bearing: a
 * round-trip loop returns the way it came, so it can't actually avoid facing the
 * wind somewhere on the loop — a "favourable" outbound bearing isn't favourable
 * overall, it just moves the headwind to the second half.
 */
export function windExposurePenalty(
  bearingDeg: number,
  forecast: RouteForecast | null,
): number {
  if (!forecast || forecast.windKph == null || forecast.windFromDeg == null) {
    return 0;
  }
  const delta = angularDelta(bearingDeg, forecast.windFromDeg);
  if (delta >= 90) return 0;
  const headwindFactor = Math.cos(toRad(delta)); // 1 at 0° (headwind), 0 at 90°
  return headwindFactor * forecast.windKph;
}

/** Forecast temperature (°C) at/above which heat is worth flagging to the athlete. */
export const HEAT_CAVEAT_THRESHOLD_C = 24;

/**
 * A short heat caveat when the forecast is hot enough to flag, else null. NOT a
 * ranking factor (see module comment) — every candidate in one request shares a
 * single forecast temperature, so it can't discriminate between routes.
 */
export function heatCaveat(forecast: RouteForecast | null): string | null {
  if (!forecast || forecast.tempC == null) return null;
  if (forecast.tempC < HEAT_CAVEAT_THRESHOLD_C) return null;
  return `${Math.round(forecast.tempC)}°C forecast — hydrate, consider an earlier start`;
}

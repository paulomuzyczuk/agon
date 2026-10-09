// Great-circle distance between two WGS-84 points. Used to derive a run's total
// distance from a GPS track when the exported file carries no cumulative-distance
// field (GPX almost never does), and by the live recorder's GPS track
// (lib/gpsTrack.ts, MZY-281) — so it lives in lib/, shared by client and server.
// Pure — no I/O, fully unit-testable.

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine distance in metres between (lat1,lng1) and (lat2,lng2). */
export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

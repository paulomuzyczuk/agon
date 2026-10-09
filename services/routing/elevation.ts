// Elevation presentation for suggested routes.
//
// Total ascent on its own doesn't tell a runner much: +300 m over 20 km is a
// gentle roll, the same +300 m over 5 km is a hill session. Every surface that
// shows a route (CLI, MCP tool, calendar event) therefore shows ascent AND
// ascent-per-km, formatted identically here so the three can't drift.
//
// Caveat worth knowing when reading the numbers: ORS derives ascent from SRTM
// elevation tiles, which are noisy at ~30 m resolution and systematically
// OVER-report cumulative climb on flat ground (a Berlin canal loop reports tens
// of metres it doesn't have). The figures are reliable for comparing candidate
// routes against each other — which is what ranking uses them for — but the
// absolute totals run high.

/** Ascent per km, or null when the route has no elevation data / no length. */
export function gainPerKm(
  elevationGainM: number | null,
  distanceM: number,
): number | null {
  if (elevationGainM === null || !(distanceM > 0)) return null;
  return elevationGainM / (distanceM / 1000);
}

/**
 * Human-readable climb, e.g. "+223 m · 27 m/km". Returns null when there is no
 * elevation data, so callers can omit the segment entirely rather than print a
 * placeholder.
 */
export function formatClimb(
  elevationGainM: number | null,
  distanceM: number,
): string | null {
  if (elevationGainM === null) return null;
  const perKm = gainPerKm(elevationGainM, distanceM);
  const base = `+${Math.round(elevationGainM)} m`;
  return perKm === null ? base : `${base} · ${Math.round(perKm)} m/km`;
}

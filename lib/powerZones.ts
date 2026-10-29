// Power training zones (MZY-63): the seven-level Coggan model, as a share of FTP.
// Pure; no I/O. Time in each zone comes from the same 1 Hz series NP is computed
// from (lib/power.ts resampleTo1Hz), so a stop doesn't pad Zone 1 and coasting
// counts as 0 W, the way Coggan counts it. Zones need an FTP: without one a ride
// has no zones, exactly as it has no IF or TSS.
//
// Model: Allen & Coggan, "Training and Racing with a Power Meter". The
// percentages are a published formula, free to use (CLAUDE.md, Prior Art).

export const POWER_ZONE_COUNT = 7;

export interface PowerZoneDef {
  /** 1..7 */
  zone: number;
  name: string;
  /** Inclusive upper bound as a percentage of FTP; null for the open top zone. */
  maxPct: number | null;
}

export const POWER_ZONES: readonly PowerZoneDef[] = [
  { zone: 1, name: 'Active recovery', maxPct: 55 },
  { zone: 2, name: 'Endurance', maxPct: 75 },
  { zone: 3, name: 'Tempo', maxPct: 90 },
  { zone: 4, name: 'Threshold', maxPct: 105 },
  { zone: 5, name: 'VO2 max', maxPct: 120 },
  { zone: 6, name: 'Anaerobic capacity', maxPct: 150 },
  { zone: 7, name: 'Neuromuscular', maxPct: null },
];

export interface PowerZoneBounds extends PowerZoneDef {
  /** Lowest whole watt in the zone. */
  minW: number;
  /** Highest whole watt in the zone; null for the open top zone. */
  maxW: number | null;
}

/** An FTP the zones can be built from (the same range the table's CHECK allows). */
export function isUsableFtp(ftpW: number | null | undefined): ftpW is number {
  return ftpW != null && Number.isFinite(ftpW) && ftpW >= 50 && ftpW <= 1000;
}

/**
 * The seven zones in watts for an FTP. Boundaries are rounded to whole watts
 * once, here, and classification uses the same numbers, so what is shown and
 * what is counted can never disagree.
 */
export function powerZoneBounds(ftpW: number): PowerZoneBounds[] {
  if (!isUsableFtp(ftpW)) {
    throw new Error(
      `powerZoneBounds: ftpW must be between 50 and 1000 W (got ${ftpW})`,
    );
  }
  let prevMax = -1;
  return POWER_ZONES.map((z) => {
    const maxW = z.maxPct === null ? null : Math.round((ftpW * z.maxPct) / 100);
    const bounds = { ...z, minW: prevMax + 1, maxW };
    if (maxW !== null) prevMax = maxW;
    return bounds;
  });
}

/** The zone (1..7) a power value falls in; negative or non-finite counts as 0 W. */
export function zoneForWatts(watts: number, ftpW: number): number {
  const w = Number.isFinite(watts) && watts > 0 ? watts : 0;
  const bounds = powerZoneBounds(ftpW);
  for (const b of bounds) {
    if (b.maxW === null || w <= b.maxW) return b.zone;
  }
  return POWER_ZONE_COUNT;
}

/**
 * Seconds in each zone (index 0 = Zone 1) over a 1 Hz series. Null without a
 * usable FTP, mirroring IF/TSS.
 */
export function timeInPowerZones(
  series: readonly number[],
  ftpW: number | null,
): number[] | null {
  if (!isUsableFtp(ftpW)) return null;
  const maxes = powerZoneBounds(ftpW).map((b) => b.maxW);
  const seconds = new Array<number>(POWER_ZONE_COUNT).fill(0);
  for (const raw of series) {
    const w = Number.isFinite(raw) && raw > 0 ? raw : 0;
    let z = 0;
    while (z < POWER_ZONE_COUNT - 1 && w > (maxes[z] as number)) z++;
    seconds[z]!++;
  }
  return seconds;
}

export interface PowerZoneRow extends PowerZoneBounds {
  seconds: number;
  /** Share of the ride's active time, 0-100, one decimal. */
  pct: number;
}

/**
 * Zones in watts joined with the seconds spent in each, for display. Null when
 * the ride has no zones (no FTP) or the stored array is not seven long.
 */
export function zoneBreakdown(
  ftpW: number | null,
  zoneSeconds: readonly number[] | null,
): PowerZoneRow[] | null {
  if (!isUsableFtp(ftpW) || zoneSeconds?.length !== POWER_ZONE_COUNT) {
    return null;
  }
  const total = zoneSeconds.reduce((a, b) => a + b, 0);
  return powerZoneBounds(ftpW).map((b, i) => ({
    ...b,
    seconds: zoneSeconds[i]!,
    pct: total > 0 ? Math.round((zoneSeconds[i]! / total) * 1000) / 10 : 0,
  }));
}

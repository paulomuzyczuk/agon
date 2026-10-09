import type { RidePowerFields } from './types';

// Pure helpers for ride power (MZY-267). No I/O — the backfill
// (services/strava/ridePowerBackfill.ts) uses these to decide what changes
// and to print its dry-run diff.

export const RIDE_POWER_FIELDS = [
  'avg_power_w',
  'max_power_w',
  'weighted_avg_power_w',
  'kilojoules',
  'power_source',
] as const satisfies ReadonlyArray<keyof RidePowerFields>;

export interface RidePowerChange {
  field: (typeof RIDE_POWER_FIELDS)[number];
  from: number | string | null;
  to: number | string | null;
}

/** Field-by-field differences between the stored and incoming power columns. */
export function diffRidePower(
  stored: RidePowerFields,
  incoming: RidePowerFields,
): RidePowerChange[] {
  const changes: RidePowerChange[] = [];
  for (const field of RIDE_POWER_FIELDS) {
    const from = stored[field];
    const to = incoming[field];
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

/** True when any power column is hand-corrected (the group is then frozen). */
export function isPowerCorrected(correctedFields: readonly string[]): boolean {
  return correctedFields.some((f) =>
    (RIDE_POWER_FIELDS as readonly string[]).includes(f),
  );
}

/** "112 W (est.)" — a display label that never hides the provenance. */
export function formatPowerLabel(
  watts: number | null,
  source: RidePowerFields['power_source'],
): string | null {
  if (watts == null || source == null) return null;
  const suffix =
    source === 'estimated' ? ' (est.)' : source === 'manual' ? ' (manual)' : '';
  return `${watts} W${suffix}`;
}

const SOURCE_LABEL = {
  device: null,
  estimated: 'estimated',
  manual: 'hand-logged',
} as const;

/**
 * The ride-detail power field, or null when there is nothing to show. The
 * provenance goes in the label ("Power (estimated)"), so an estimate can
 * never be read as a measurement. Value: "avg / max W · kJ", whichever exist.
 */
export function formatRidePowerField(p: {
  avgW: number | null;
  maxW: number | null;
  kj: number | null;
  source: NonNullable<RidePowerFields['power_source']>;
}): { label: string; value: string } | null {
  const parts: string[] = [];
  if (p.avgW != null) {
    parts.push(p.maxW != null ? `${p.avgW} / ${p.maxW} W` : `${p.avgW} W`);
  }
  if (p.kj != null) parts.push(`${Math.round(p.kj)} kJ`);
  if (parts.length === 0) return null;
  const tag = SOURCE_LABEL[p.source];
  const base = p.avgW != null && p.maxW != null ? 'Avg / max power' : 'Power';
  return { label: tag ? `${base} (${tag})` : base, value: parts.join(' · ') };
}

/**
 * The ride-detail field for Agon's measured-power metrics (MZY-269): "NP
 * 231 W · IF 0.84 · TSS 72", or "NP 231 W (no FTP set)" when IF/TSS could
 * not be anchored. Only ever built from a power meter's stream, so it never
 * needs an "(estimated)" tag.
 */
export function formatPowerMetricsField(m: {
  npW: number;
  intensityFactor: number | null;
  tss: number | null;
}): { label: string; value: string } {
  const label = 'NP · IF · TSS';
  if (m.intensityFactor == null || m.tss == null) {
    return { label, value: `NP ${m.npW} W (no FTP set)` };
  }
  return {
    label,
    value: `NP ${m.npW} W · IF ${m.intensityFactor.toFixed(2)} · TSS ${Math.round(m.tss)}`,
  };
}

/** "5 s", "1 min", "20 min", "1 h", "1.5 h" — a power-curve duration label. */
export function formatCurveDuration(s: number): string {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

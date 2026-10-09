// Gear domain: categories, the deterministic local-id rule, and the athlete's
// device timeline. All pure (no DB) so it's shared + unit-testable. The DB
// operations live in services/gear.ts.

export type GearCategory =
  'shoe' | 'hrm' | 'watch' | 'wristband' | 'bike' | 'other';

export interface GearSpec {
  gear_id: string;
  name: string;
  brand: string | null;
  category: GearCategory;
  /**
   * Wheel circumference (mm) — bike-only, needed to derive speed/distance from
   * a BLE CSC speed sensor's raw wheel-revolution count (lib/bluetoothCycling.ts
   * computeWheelSpeedKmh; see MZY-168). Undefined for every non-bike category
   * and for a bike with no known-good measured circumference yet.
   */
  wheelCircumferenceMm?: number;
}

/**
 * Deterministic local id for gear Strava has no id for (HRMs, watches, or a shoe
 * logged by voice note): 'local:<slug>'. Stable — the same name always yields
 * the same id, guaranteeing one id per physical item. Throws on a name that
 * slugs to nothing.
 */
export function localGearId(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics (Í -> I, etc.)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // non-alphanumeric runs -> single hyphen
    .replace(/^-+|-+$/g, ''); // trim leading/trailing hyphens
  if (!slug) {
    throw new Error(`localGearId: name '${name}' has no slug-able characters`);
  }
  return `local:${slug}`;
}

// ── Heart-rate monitor timeline (athlete config) ──────────────────────────────
// Each run's HRM is inferred from its date: the H9 until end of June 2026, the
// Garmin HRM 200 from July 2026 on. (The H9↔Samsung sync was unreliable, so this
// records the device WORN, independent of whether HR data reached Strava.)
export const POLAR_H9: GearSpec = {
  gear_id: 'local:polar-h9',
  name: 'Polar H9',
  brand: 'Polar',
  category: 'hrm',
};

export const GARMIN_HRM_200: GearSpec = {
  gear_id: 'local:garmin-hrm-200',
  name: 'Garmin HRM 200',
  brand: 'Garmin',
  category: 'hrm',
};

// ── Bike (athlete config) ─────────────────────────────────────────────────────
// Single current bike, not a timeline: unlike the HRM history above (two real
// straps worn across different date ranges), the athlete has owned exactly one
// bike since rides were first tracked (2026-09-10) — a per-date lookup table
// would model a scenario that doesn't exist yet. A second bike later just adds
// a segment list here, mirroring HRM_TIMELINE, rather than a rewrite.
export const MERIDA_SILEX_400: GearSpec = {
  gear_id: 'local:merida-silex-400',
  name: 'Merida Silex 400',
  brand: 'Merida',
  category: 'bike',
  wheelCircumferenceMm: 2242,
};

interface HrmSegment {
  from: string; // inclusive YYYY-MM-DD
  to: string | null; // inclusive YYYY-MM-DD, or null = open-ended
  gear: GearSpec;
}

const HRM_TIMELINE: HrmSegment[] = [
  { from: '0000-01-01', to: '2026-06-30', gear: POLAR_H9 },
  { from: '2026-07-01', to: null, gear: GARMIN_HRM_200 },
];

/** The HRM worn on a given run date, or null if outside every segment. */
export function hrmForDate(dateISO: string): GearSpec | null {
  for (const seg of HRM_TIMELINE) {
    if (dateISO >= seg.from && (seg.to === null || dateISO <= seg.to)) {
      return seg.gear;
    }
  }
  return null;
}

/**
 * The HRM to attribute to a run. The date timeline only applies when the run
 * actually has heart-rate data — if HR is absent (the strap wasn't worn, or its
 * data never reached Strava), we assume the run was done WITHOUT an HRM and link
 * none. `avgHr` is the run's average_heartrate (null when no HR was recorded).
 */
export function hrmForRun(
  avgHr: number | null,
  dateISO: string,
): GearSpec | null {
  return avgHr != null ? hrmForDate(dateISO) : null;
}

/** Non-Strava gear seeded into the catalog by scripts/seed-gear.ts. */
export const SEED_GEAR: GearSpec[] = [POLAR_H9, GARMIN_HRM_200, MERIDA_SILEX_400];

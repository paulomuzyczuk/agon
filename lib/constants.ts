// Shared, provider-neutral constants. Domain facts that both ingestion and
// (later) analytics/UI need live here once.

/** Ingestion provenance tag written to `runs.source` and similar columns. */
export const DATA_SOURCES = {
  STRAVA: 'strava',
  POLAR: 'polar',
  TELEGRAM: 'telegram',
  MANUAL: 'manual',
  GOOGLE_HEALTH: 'google_health',
  // Generic file-import sources (Workstream B): a run parsed from an exported
  // GPX/TCX/FIT file, tagged by the platform it came from. The free, ungated
  // fallback for Samsung Health / Garmin (no live server API) and Strava exports.
  SAMSUNG_EXPORT: 'samsung_export',
  GARMIN_EXPORT: 'garmin_export',
  STRAVA_EXPORT: 'strava_export',
  // Browser-side live recording (app/record): flushed from IndexedDB on
  // stop/reconnect. Named for the mechanism, not the transport (today's HR
  // comes over BLE, but a later GPS stream would be browser Geolocation and
  // land in the same run_streams row).
  LIVE_RECORDING: 'live_recording',
} as const;
export type DataSource = (typeof DATA_SOURCES)[keyof typeof DATA_SOURCES];

/**
 * The subset of sources produced by the generic run-file importer
 * (services/fileImport). A run's `source` is one of these when it came from an
 * exported file rather than a live API pull.
 */
export const FILE_IMPORT_SOURCES = [
  DATA_SOURCES.SAMSUNG_EXPORT,
  DATA_SOURCES.GARMIN_EXPORT,
  DATA_SOURCES.STRAVA_EXPORT,
] as const;
export type FileImportSource = (typeof FILE_IMPORT_SOURCES)[number];

/** True when `s` is one of the generic file-import source tags. */
export function isFileImportSource(s: string): s is FileImportSource {
  return (FILE_IMPORT_SOURCES as readonly string[]).includes(s);
}

// ── Athlete-personal profile anchors moved out (self-hosting decision) ─────────
// TRAINING_START_DATE, PROGRAM_WEEKS_PER_BLOCK, PROGRAM_BLOCK_COUNT,
// ATHLETE_TIME_ZONE, SWEAT_RATE_BASELINE_L_PER_H, ATHLETE_HR_MAX, ATHLETE_HR_REST,
// ATHLETE_WEIGHT_KG_FALLBACK, ATHLETE_STARTING_WEIGHT_KG,
// ATHLETE_STARTING_BODY_FAT_PCT, LIFT_SWEAT_RATE_L_PER_H, and
// SWEAT_SODIUM_MG_PER_L used to be hardcoded exports here. They are
// per-installer configuration (every self-hoster runs their own program with
// their own numbers), not code — moved to lib/athleteProfile.ts's
// getAthleteProfile(), which loads them from config/athlete-profile.local.json
// (gitignored; config/athlete-profile.example.json is the committed template).

/**
 * Strava `sport_type` / `type` values we treat as runs for the `runs` table.
 * Everything else (rides, swims, weight sessions logged to Strava, etc.) is
 * skipped by the backfill — lifting has its own capture path.
 */
export const STRAVA_RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);

/**
 * Strava `sport_type` / `type` values we treat as bike rides for the `rides`
 * table. Mirrors STRAVA_RUN_TYPES above.
 */
export const STRAVA_RIDE_TYPES = new Set([
  'Ride',
  'VirtualRide',
  'EBikeRide',
  'GravelRide',
  'MountainBikeRide',
]);

// ── Nutrition — water goal formula (lib/nutritionGoals.ts) ─────────────────────
// A planned RUN's water addition is (distance × assumed pace) × sweat rate; the
// assumed pace prefers the athlete's own recent average (services/nutritionGoals
// queries it) and only falls back to this constant when there isn't enough run
// history yet (e.g. a brand-new install). ~6:00/km, a typical easy-run pace for
// this athlete's profile — deliberately conservative (slower pace → more assumed
// time → more assumed water), revisit once real pace data exists.
export const DEFAULT_EASY_PACE_S_PER_KM = 360;

// A planned LIFT session has no target distance/duration in `planned_sessions`
// to derive a duration from (CLAUDE.md Premium-Parity #5 keeps the adjustment
// model simple and documented), so the water addition uses a flat assumed
// duration; the per-installer sweat rate itself is
// getAthleteProfile().liftSweatRateLPerH (see lib/athleteProfile.ts).
export const LIFT_ASSUMED_DURATION_H = 1;

// ── Long-run prep reminder (calendar sync) ──────────────────────────────────
// A run event at/above this distance gets a Vaseline/anti-chafing reminder plus
// a suggested refueling line in its calendar description (services/googleCalendar
// eventMap.ts), prompted by an actual inner-thigh chafing incident from a
// forgotten-Vaseline 23 km run (2026-08-24).
export const LONG_RUN_REMINDER_KM = 15;

// Carb intake guideline (g/h) for 1-2.5h efforts (CLAUDE.md Premium-Parity #5);
// up to ~90 g/h is possible with glucose:fructose mixes but isn't the default
// suggestion here.
export const CARBS_G_PER_H_MIN = 30;
export const CARBS_G_PER_H_MAX = 60;

// ── Standard Fueling Solution dosing (calendar sync) ────────────────────────
// The athlete's homemade long-run drink (lib/fuelingCatalog.ts) is dosed in
// whole bottles, scaled to distance rather than a flat amount: FUELING_BASE_
// BOTTLES once a run crosses LONG_RUN_REMINDER_KM, one more bottle for every
// further FUELING_BOTTLE_STEP_KM. Calibrated against the athlete's own
// reported intake on long runs rather than a guess, and checked against the
// sports-science sources: at an easy program pace and a typical sweat rate
// this delivers roughly 30-35 g/h carbs (inside the NSCA 30-60 g/h during-exercise guideline the
// whole time, per dietary-carbohydrate-for-athletes.md in the sports-science
// vault) and 79-94% fluid replacement rising with distance but never
// exceeding estimated sweat loss (no hyponatremia risk per
// hydration-and-fluid-balance.md — the risk is drinking beyond sweat losses,
// especially with low-sodium fluid, and this mix carries real sodium).
export const FUELING_BASE_BOTTLES = 2;
export const FUELING_BOTTLE_STEP_KM = 5;

// ── Bike sessions — target distance inference (Premium-Parity #6 cycling) ──
// planned_sessions carries no duration/target-distance field for bike sessions
// the way runs have targetDistanceKm, so the route builder can't size a loop
// directly. It reuses the same flat 45-minute "easy Zone 2 spin" duration the
// calendar sync already assumes for the event block (services/googleCalendar/
// eventMap.ts) × an easy cycling speed — same "keep the adjustment model
// simple and documented" posture as the nutrition water-goal formulas above.
export const BIKE_ASSUMED_DURATION_MIN = 45;
export const EASY_BIKE_SPEED_KMH = 20;

// ── Bluetooth Low Energy GATT identifiers (Web Bluetooth PoC) ──────────────
// Standard Bluetooth SIG GATT service/characteristic name strings (the
// browser resolves these to their canonical 16-bit UUIDs). Used to filter the
// native device picker to heart-rate-capable straps only (app/record).
export const BLE_HEART_RATE_SERVICE = 'heart_rate';
export const BLE_HEART_RATE_MEASUREMENT_CHARACTERISTIC =
  'heart_rate_measurement';

// Cycling Speed and Cadence service (MZY-168) — broadcast by the Garmin Speed
// Sensor 2 and Cadence Sensor 2 alike (two separate physical devices sharing
// one GATT service; lib/bluetoothCycling.ts tells them apart by which
// Measurement fields are present per connection).
export const BLE_CSC_SERVICE = 'cycling_speed_and_cadence';
export const BLE_CSC_MEASUREMENT_CHARACTERISTIC = 'csc_measurement';

// Cycling Power service 0x1818 / Measurement 0x2A63 (MZY-270) — power-meter
// pedals, cranks and smart trainers; decoded by lib/bluetoothPower.ts.
export const BLE_CYCLING_POWER_SERVICE = 'cycling_power';
export const BLE_CYCLING_POWER_MEASUREMENT_CHARACTERISTIC =
  'cycling_power_measurement';

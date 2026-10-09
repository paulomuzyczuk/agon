// Shared, serializable shapes for rides + gear mileage, as the PWA consumes
// them. Split out of lib/marts.ts (already over the 500-line file-size
// budget before this feature — see scripts/check-file-size-budget.mjs)
// rather than growing that file further. Same rules as lib/marts.ts: lives
// in lib/ so API route handlers and client components can both import these
// without pulling server-only DB code into the browser bundle; every field
// here is JSON-serializable.

import type { ActivityCorrectionState } from './activityCorrection';
import type { StopSuggestionView } from './missedStopDetection';
import type { PowerSource } from './types';

// ── Bike rides ───────────────────────────────────────────────────────────────

/** One row in the recent-rides list. */
export interface RideListItem {
  id: string;
  date: string;
  distanceKm: number | null;
  durationS: number | null;
  avgSpeedKmh: number | null;
  avgHr: number | null;
  maxHr: number | null;
  tempC: number | null;
  weatherConditions: string | null;
  hasRoute: boolean;
  /** Any field hand-corrected (MZY-253). */
  corrected: boolean;
}

export interface RidesResponse {
  rides: RideListItem[];
}

/** A ride's GPS route + one HR/distance/altitude stream, index-aligned. */
export interface RideStream {
  source: string;
  timeS: (number | null)[];
  heartrate: (number | null)[];
  distanceM: (number | null)[];
  altitudeM: (number | null)[];
  lat: (number | null)[];
  lng: (number | null)[];
}

/**
 * A ride's power summary with its provenance (MZY-267). `source` is never
 * dropped on the way to the page: 'estimated' (the source's model — every
 * ride without a power meter) and 'manual' must be labelled as such.
 */
export interface RidePower {
  avgW: number | null;
  maxW: number | null;
  /** The source's NP-like figure (Strava weighted avg; meter rides only). */
  weightedW: number | null;
  kj: number | null;
  source: PowerSource;
}

/**
 * Agon's own power metrics for a ride (MZY-269), computed ONLY from a power
 * meter's measured stream — so they need no provenance label, and are null
 * for every estimated or meter-less ride. IF/TSS are null without an FTP.
 */
export interface RideMeasuredPower {
  npW: number;
  intensityFactor: number | null;
  tss: number | null;
  ftpW: number | null;
  /** ride_streams.source of the device series. */
  streamSource: string;
  /** Mean-maximal power, ascending duration. */
  curve: Array<{ durationS: number; watts: number }>;
}

export interface RideDetail {
  id: string;
  date: string;
  block: number | null;
  week: number | null;
  distanceKm: number | null;
  durationS: number | null;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  avgHr: number | null;
  maxHr: number | null;
  elevationGainM: number | null;
  bikeUsed: string | null;
  perceivedEffort: number | null;
  generalNotes: string | null;
  tempC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  weatherConditions: string | null;
  source: string | null;
  relativeEffort: number | null;
  relativeEffortMethod: 'stream' | 'average' | null;
  /** Null when the ride has no power at all. */
  power: RidePower | null;
  /** NP/IF/TSS + curve from measured power; null without a meter stream. */
  measuredPower: RideMeasuredPower | null;
  correction: ActivityCorrectionState;
  /** Open missed-stop suggestion (MZY-254), if any. */
  stopSuggestion: StopSuggestionView | null;
  /** Devices that recorded the streams (MZY-271), e.g. "Assioma Duo (power)"; null = unknown. */
  sensors: string | null;
  stream: RideStream | null;
}

// ── Gear mileage (shoes + bikes) ────────────────────────────────────────────

/** One gear item's total mileage, summed across runs + rides. */
export interface GearMileageItem {
  gearId: string;
  name: string;
  category: string;
  brand: string | null;
  retired: boolean;
  totalKm: number | null;
  activityCount: number;
  /** Names of overdue maintenance tasks (bikes only — see gearMileage()). */
  dueMaintenanceTasks: string[];
}

/** GET /api/gear response. */
export interface GearResponse {
  gear: GearMileageItem[];
}

// Shared, serializable shapes for the analytics marts as the PWA consumes them.
// Lives in lib/ (not services/) so both the API route handlers AND client
// components can import these types without pulling server-only DB code into the
// browser bundle. Keep every field here JSON-serializable.

import type { ActivityCorrectionState } from './activityCorrection';
import type { StopSuggestionView } from './missedStopDetection';

/** TrainingPeaks/Strava Form bands, as emitted by fct_training_load_daily. */
export type FormZone =
  'high fatigue' | 'optimal training' | 'grey zone' | 'fresh' | 'transition';

/** One calendar day of the Fitness/Fatigue/Form curve. */
export interface TrainingLoadPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Sum of that day's per-run Relative Effort (0 on rest days). */
  dailyLoad: number;
  /** Fitness — 42-day EWMA of daily load. */
  ctl: number;
  /** Fatigue — 7-day EWMA of daily load. */
  atl: number;
  /** Form — CTL − ATL. Negative = fatigued/building, positive = fresh. */
  tsb: number;
  /** Day-over-day change in CTL (ramp rate); null on the first day. */
  ctlDelta: number | null;
  /** Coaching gloss on TSB. */
  formZone: FormZone;
}

/** GET /api/training-load response. */
export interface TrainingLoadResponse {
  /** Ascending by date. */
  series: TrainingLoadPoint[];
  /** Convenience: the most recent day (last element of `series`), or null. */
  latest: TrainingLoadPoint | null;
}

/**
 * One predicted race time, as emitted by fct_race_predictions. Grain: one row
 * per target distance (1k/5k/10k/half/marathon/70k).
 */
export interface RacePrediction {
  /** Human label, e.g. `10K`, `Half-Marathon`. */
  label: string;
  /** Target distance in metres. */
  distanceM: number;
  /** Headline predicted time in seconds (self-recalibrated Riegel). */
  predictedS: number;
  /** Derived headline pace, seconds per km. */
  predictedPaceSPerKm: number;
  /** Lower / upper bound of the error band, seconds. */
  lowS: number;
  highS: number;
  /** Half-width of the band as a fraction of the prediction (e.g. 0.03 = ±3%). */
  bandPct: number;
  /** Riegel with the athlete's own recalibrated exponent (= headline). */
  riegelSelfS: number;
  /** Riegel with the generic k=1.06 exponent, reported as a baseline. */
  riegelGenericS: number;
  /** Daniels VDOT cross-check, or null when unavailable. */
  vdotS: number | null;
  /** |riegelSelf − vdot| — model agreement (small = more confident); null if no VDOT. */
  riegelVdotGapS: number | null;
  /** True past the longest real effort — render with a wide band + caveat, never as a point. */
  extrapolated: boolean;
  /**
   * The athlete's actual realized best effort at this exact distance, from
   * fct_run_best_efforts (source-agnostic, net-pace-corrected). Null when no
   * best-effort bucket pairs with this prediction row (e.g. 70K — a pure
   * extrapolation with nothing in STANDARD_EFFORT_DISTANCES).
   */
  verified: VerifiedBestEffort | null;
}

/**
 * The athlete's realized PR at one prediction row's exact distance, as
 * emitted by fct_run_best_efforts (public.run_best_efforts, `pnpm be:backfill`).
 */
export interface VerifiedBestEffort {
  elapsedTimeS: number;
  paceSPerKm: number;
  /** stream = sliding-window PR search over GPS/pace data; whole_run = coarser fallback. */
  method: 'stream' | 'whole_run';
  /** Which run_streams source fed a stream-method PR (e.g. strava, google_health); null for whole_run. */
  streamSource: string | null;
  /** The run that set this PR, for linking to /runs/[id]; null if unavailable. */
  prRunId: string | null;
  /** Local calendar day the PR was set, `YYYY-MM-DD`. */
  achievedAt: string;
}

/** Provenance of the recalibrated Riegel fit, shared across all rows. */
export interface RacePredictionFit {
  /** Recalibrated Riegel exponent from the athlete's own best-effort pairs. */
  fitK: number;
  /** R² of the log-log fit (closeness to 1 = tighter fit). */
  fitR2: number;
  /** True when the fit fell back to the generic k=1.06 (too few pairs). */
  fitFallback: boolean;
  /** Number of best-effort pairs the fit used. */
  nPairs: number;
  /** Reference VDOT derived from the best 5K split, for the cross-check. */
  refVdot: number | null;
}

/** GET /api/race-predictions response. */
export interface RacePredictionsResponse {
  /** Ascending by distance. */
  predictions: RacePrediction[];
  /** The shared fit provenance (same across every row), or null if no data. */
  fit: RacePredictionFit | null;
}

/** How a run's Relative Effort was computed — determines certainty. */
export type RelativeEffortMethod = 'stream' | 'average' | 'estimated_pace';

/** One scored run, as emitted by fct_relative_effort. Grain: one row per run. */
export interface RelativeEffortRun {
  runId: string;
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  block: number | null;
  week: number | null;
  distanceKm: number | null;
  durationS: number | null;
  /** Banister TRIMP score for the session. */
  relativeEffort: number;
  /** RE accrued per hour (intensity density). */
  relativeEffortPerHour: number | null;
  /** stream = full HR series (most certain); average = avg HR only; estimated_pace = no HR. */
  method: RelativeEffortMethod;
  /** Which HR series fed a stream-integrated score (e.g. strava/fitbit); null otherwise. */
  streamSource: string | null;
}

/** GET /api/relative-effort response. */
export interface RelativeEffortResponse {
  /** Most-recent first. */
  runs: RelativeEffortRun[];
}

/**
 * One calendar day of recovery signals, as emitted by fct_wellness_daily. The
 * three upstream sources are sparse and don't all cover the same days, so any
 * field may be null — render a null as a gap, never as zero.
 */
export interface WellnessDayPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Resting heart rate (bpm). */
  restingHr: number | null;
  /** All-day active minutes. */
  activeMinutes: number | null;
  /** HRV — whole-night RMSSD (ms). */
  hrvRmssd: number | null;
  /** HRV — deep-sleep RMSSD (ms). */
  hrvDeepRmssd: number | null;
  /** Total minutes asleep (summed over the day's sleep sessions). */
  sleepMinutes: number | null;
  /** Sleep efficiency — asleep ÷ in-bed (%). */
  sleepEfficiency: number | null;
  /** Sleep stage split, minutes. */
  sleepDeepMin: number | null;
  sleepLightMin: number | null;
  sleepRemMin: number | null;
  sleepWakeMin: number | null;
}

/** The most recent non-null reading of one metric within the window. */
export interface WellnessLatestStat {
  /** The value (units depend on the metric). */
  value: number;
  /** The day it was read, `YYYY-MM-DD`. */
  date: string;
}

/**
 * Latest reading per headline metric. Computed independently per metric (not a
 * single "last day") because the signals are sparse — the most recent resting-HR
 * day is usually not the most recent sleep or HRV day.
 */
export interface WellnessLatest {
  restingHr: WellnessLatestStat | null;
  hrvRmssd: WellnessLatestStat | null;
  /** Sleep duration in HOURS (converted from minutes). */
  sleepHours: WellnessLatestStat | null;
  sleepEfficiency: WellnessLatestStat | null;
  activeMinutes: WellnessLatestStat | null;
}

/** GET /api/wellness response. */
export interface WellnessResponse {
  /** Ascending by date. */
  series: WellnessDayPoint[];
  /** Most recent reading per metric (each may come from a different day). */
  latest: WellnessLatest;
}

// ── Nutrition: lib/martsNutrition.ts ──────────────────────────────────────────
export * from './martsNutrition';

// ── General health (decision 2026-08-24) ────────────────────────────────────

/** One marker result within a lab panel. */
export interface LabResultPoint {
  marker: string;
  valueNumeric: number | null;
  valueText: string | null;
  unit: string | null;
  flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
  /** True when the lab-ingestion skill's extraction confidence fell below threshold. */
  needsReview: boolean;
}

/** One test event (blood panel, spermogram, hormone panel, ...) with its results. */
export interface LabPanelSummary {
  id: string;
  date: string;
  panelType: string;
  labName: string | null;
  results: LabResultPoint[];
}

/**
 * One marker result, flat (no per-panel nesting) — the shape the trend chart
 * consumes. Mirrors sihha's PsychometricResult (public repo
 * services/clinicianCharts.ts): a flat list across every test event, with the
 * reference range as the cross-marker comparable unit (sihha uses percentile
 * for that role; labs don't have one, so the reference range fills it — see
 * lib/labTrends.ts).
 */
export interface LabResultTrendRow {
  date: string;
  panelType: string;
  marker: string;
  valueNumeric: number | null;
  unit: string | null;
  referenceLow: number | null;
  referenceHigh: number | null;
  flag: 'low' | 'normal' | 'high' | 'abnormal' | null;
  needsReview: boolean;
}

/** GET /api/general-health/lab-trends response. */
export interface LabTrendsResponse {
  /** Every marker result across every panel, ascending by date. */
  results: LabResultTrendRow[];
}

/** One skincare/dental routine, with its steps. */
export interface RoutineSummary {
  id: string;
  name: string;
  routineType: 'skincare' | 'dental';
  timeOfDay: 'am' | 'pm' | 'any' | null;
  steps: { product: string; notes: string | null }[];
}

/** 7-day adherence for one routine. */
export interface RoutineAdherenceSummary {
  routineId: string;
  routineName: string;
  loggedDays: number;
  completedDays: number;
}

/** One active medication/supplement. */
export interface MedicationSummary {
  id: string;
  name: string;
  kind: 'medication' | 'supplement';
  dosage: string | null;
  schedule: string | null;
  active: boolean;
}

/** One injury/pain entry. */
export interface InjurySummary {
  id: string;
  onsetDate: string;
  bodyPart: string;
  description: string | null;
  severity: number | null;
  status: 'active' | 'improving' | 'resolved';
  resolvedDate: string | null;
}

/** One doctor/dentist/specialist visit. */
export interface MedicalVisitSummary {
  id: string;
  date: string;
  visitType: string;
  provider: string | null;
  reason: string | null;
  findings: string | null;
  followUpDate: string | null;
}

/** One immunization record. */
export interface VaccinationSummary {
  id: string;
  vaccine: string;
  date: string;
  doseNumber: number | null;
  nextDueDate: string | null;
}

/** One allergy or chronic condition. */
export interface HealthConditionSummary {
  id: string;
  conditionType: 'allergy' | 'chronic_condition' | 'other';
  name: string;
  severity: string | null;
  status: 'active' | 'resolved' | 'managed';
  diagnosedDate: string | null;
}

/** One row in the recent-runs list. */
export interface RunListItem {
  id: string;
  date: string;
  distanceKm: number | null;
  durationS: number | null;
  avgPaceSPerKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
  tempC: number | null;
  weatherConditions: string | null;
  relativeEffort: number | null;
  hasRoute: boolean;
  /** Any field hand-corrected (MZY-253). */
  corrected: boolean;
}

export interface RunsResponse {
  runs: RunListItem[];
}

/** A run's GPS route + one HR/pace/altitude stream, index-aligned. */
export interface RunStream {
  source: string;
  timeS: (number | null)[];
  heartrate: (number | null)[];
  distanceM: (number | null)[];
  altitudeM: (number | null)[];
  lat: (number | null)[];
  lng: (number | null)[];
}

export interface RunDetail {
  id: string;
  date: string;
  block: number | null;
  week: number | null;
  distanceKm: number | null;
  durationS: number | null;
  avgPaceSPerKm: number | null;
  avgHr: number | null;
  maxHr: number | null;
  elevationGainM: number | null;
  shoeUsed: string | null;
  perceivedEffort: number | null;
  painLocation: string | null;
  painOnsetKm: number | null;
  generalNotes: string | null;
  tempC: number | null;
  humidityPct: number | null;
  windKph: number | null;
  weatherConditions: string | null;
  source: string | null;
  relativeEffort: number | null;
  relativeEffortMethod: RelativeEffortMethod | null;
  /** Elapsed time actually moving (s) — see movingFlagSource for which stop-detection source was used. */
  movingTimeS: number | null;
  /** Elapsed time NOT moving — detected stops, e.g. forced ones at red lights (s). */
  pausedTimeS: number | null;
  /**
   * Which stop-detection source fed movingTimeS/estimatedNetTimeS: Strava's
   * real per-sample flag when available, else the in-house speed-threshold
   * equivalent (lib/movingTime.ts::deriveMovingFlags, calibrated F1 0.98
   * against Strava ground truth). Null when the run has no distance-bearing
   * stream at all.
   */
  movingFlagSource: 'strava' | 'derived' | null;
  /**
   * Estimated net time (s) discounting the "free speed" a forced stop's rest
   * lends to the segment right after it — see lib/movingTime.ts. More honest
   * than a naive distance/movingTime split, which assumes zero fatigue cost
   * from the missing rest. Null when the run has no distance-bearing stream
   * at all — nothing to correct against.
   */
  estimatedNetTimeS: number | null;
  /** estimatedNetTimeS / distanceKm — for reading alongside Avg pace. */
  estimatedNetPaceSPerKm: number | null;
  /** Real forced stops (>= 5s) the net-time estimate accounted for. */
  netTimeStopsCounted: number | null;
  correction: ActivityCorrectionState;
  /** Open missed-stop suggestion (MZY-254), if any. */
  stopSuggestion: StopSuggestionView | null;
  /** Devices that recorded the streams (MZY-271), e.g. "Garmin HRM 200 (HR)"; null = unknown. */
  sensors: string | null;
  stream: RunStream | null;
}

/** One week's run compliance vs. the training program. */
export interface RunComplianceWeek {
  block: number;
  week: number;
  blockWeek: string;
  actualKm: number | null;
  targetKm: number | null;
  kmCompliancePct: number | null;
  easyRunsCapped: number | null;
  easyRunsCompliant: number | null;
  hrCompliancePct: number | null;
}

export interface RunComplianceResponse {
  weeks: RunComplianceWeek[];
}

// ── Body composition (fct_body_comp_trend) ──────────────────────────────────

/**
 * One calendar day of body composition, as emitted by fct_body_comp_trend.
 * Weigh-ins are sparse and irregular (roughly monthly) — either field may be
 * null on a given day; render a null as a gap, never as zero.
 */
export interface BodyCompPoint {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  weightKg: number | null;
  bodyFatPct: number | null;
}

/** The most recent non-null reading of one metric within the window. */
export interface BodyCompLatestStat {
  value: number;
  /** The day it was read, `YYYY-MM-DD`. */
  date: string;
}

/** Latest reading per metric — computed independently, since weight and BF% rarely land on the same day. */
export interface BodyCompLatest {
  weightKg: BodyCompLatestStat | null;
  bodyFatPct: BodyCompLatestStat | null;
}

/** GET /api/body-comp response. */
export interface BodyCompResponse {
  /** Ascending by date. */
  series: BodyCompPoint[];
  latest: BodyCompLatest;
  /** Athlete Profile starting figures (CLAUDE.md), for a "since start" reference line. */
  startingWeightKg: number;
  startingBodyFatPct: number;
}

/** GET /api/health response — a cross-domain general-health snapshot. */
export interface HealthResponse {
  recentLabPanels: LabPanelSummary[];
  routines: RoutineSummary[];
  routineAdherence: RoutineAdherenceSummary[];
  activeMedications: MedicationSummary[];
  activeInjuries: InjurySummary[];
  recentMedicalVisits: MedicalVisitSummary[];
  upcomingFollowUps: { what: string; due: string }[];
  vaccinations: VaccinationSummary[];
  healthConditions: HealthConditionSummary[];
}

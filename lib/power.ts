// Pure power-meter metrics (MZY-269), DB-free + unit-tested. Agon's own
// Normalized Power, Intensity Factor, Training Stress Score and mean-maximal
// power curve: the formulas Strava and TrainingPeaks keep behind a paywall.
//
// Formulas: Allen & Coggan, "Training and Racing with a Power Meter"
// (published, free to use). sweatpy (MIT) was the reference implementation
// they were checked against. This is a fresh TypeScript implementation; no
// code is copied from it or from GoldenCheetah (GPL). See CREDITS.md.
//
//   NP  = ( mean( rolling30sMean(P)^4 ) )^(1/4)   over a 1 Hz series
//   IF  = NP / FTP
//   TSS = (seconds · NP · IF) / (FTP · 3600) · 100   (1 h at FTP = 100)
//
// PROVENANCE: callers pass ONLY device-measured watts (ride_streams
// watts_source = 'device'). An estimated series run through these functions
// would yield numbers that look measured — the gate lives in the loader
// (services/ridePowerMetrics.ts), these functions cannot tell the difference.
// TSS never feeds training load (.claude/rules/premium-parity.md #8).

/** Rolling-average window of Normalized Power (Coggan: 30 s). */
export const NP_WINDOW_S = 30;

/**
 * Longest time gap (s) between two samples that is bridged by holding the
 * earlier value — a dropped BLE frame or a 2-4 s recording interval. A longer
 * gap is an auto-pause or a stop and is REMOVED from the timeline, not
 * zero-filled, so a café stop doesn't drag NP and the power curve down.
 */
export const MAX_HOLD_GAP_S = 5;

/** Above this a sample is a sensor glitch (e.g. 0xFFFF), treated as a dropout. */
export const MAX_PLAUSIBLE_W = 3000;

/** Mean-maximal durations (s): sprint, anaerobic, VO2max, threshold, endurance. */
export const POWER_CURVE_DURATIONS_S = [
  1, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200,
] as const;

export interface PowerCurvePoint {
  durationS: number;
  watts: number;
}

export interface RidePowerMetrics {
  /** Normalized Power (W). */
  npW: number;
  /** NP / FTP, 3 decimals. Null without an FTP. */
  intensityFactor: number | null;
  /** Training Stress Score, 1 decimal. Null without an FTP. */
  tss: number | null;
  /** FTP (W) used for IF/TSS, null when none was set. */
  ftpW: number | null;
  /** Active seconds in the resampled series (stops removed). */
  durationS: number;
  avgPowerW: number;
  maxPowerW: number;
  /** Mechanical work over the active timeline (kJ), 1 decimal. */
  kilojoules: number;
  curve: PowerCurvePoint[];
}

function cleanWatts(w: number | null | undefined): number {
  if (w == null || !Number.isFinite(w) || w < 0 || w > MAX_PLAUSIBLE_W) {
    return 0; // dropout, coasting, or glitch — Coggan counts coasting as 0 W
  }
  return w;
}

/**
 * Resample an index-aligned (timeS, watts) stream to one value per active
 * second. Each sample holds until the next one when the gap is at most
 * MAX_HOLD_GAP_S; a longer gap contributes only the sample's own second
 * (the pause itself is dropped). Null/negative/glitch values count as 0 W.
 * Samples are bucketed by whole second (floor); within a second only the
 * first counts, and a duplicate or out-of-order timestamp is skipped.
 */
export function resampleTo1Hz(
  timeS: readonly number[],
  watts: readonly (number | null)[],
): number[] {
  const out: number[] = [];
  const n = Math.min(timeS.length, watts.length);
  // Each sample's whole second; the first sample in a second represents it,
  // so a 4 Hz meter is not counted four times.
  const sec = (k: number) => Math.floor(timeS[k]!);
  let i = 0;
  while (i < n) {
    const w = cleanWatts(watts[i]);
    // Next sample in a strictly later second (skips same-second, duplicate
    // and out-of-order samples).
    let j = i + 1;
    while (j < n && sec(j) <= sec(i)) j++;
    const dt = j < n ? sec(j) - sec(i) : 1;
    const hold = dt <= MAX_HOLD_GAP_S ? dt : 1;
    for (let k = 0; k < hold; k++) out.push(w);
    i = j;
  }
  return out;
}

/** Normalized Power (W) of a 1 Hz series; null when shorter than the window. */
export function normalizedPower(series: readonly number[]): number | null {
  if (series.length < NP_WINDOW_S) return null;
  let windowSum = 0;
  let sum4 = 0;
  let count = 0;
  for (let i = 0; i < series.length; i++) {
    windowSum += series[i]!;
    if (i >= NP_WINDOW_S) windowSum -= series[i - NP_WINDOW_S]!;
    if (i >= NP_WINDOW_S - 1) {
      const avg = windowSum / NP_WINDOW_S;
      sum4 += avg ** 4;
      count++;
    }
  }
  return (sum4 / count) ** 0.25;
}

/** NP / FTP, or null without a usable FTP. */
export function intensityFactor(
  npW: number,
  ftpW: number | null,
): number | null {
  if (ftpW == null || ftpW <= 0) return null;
  return npW / ftpW;
}

/** Training Stress Score; one hour at FTP = 100. Null without a usable FTP. */
export function trainingStressScore(
  durationS: number,
  npW: number,
  ftpW: number | null,
): number | null {
  const intensity = intensityFactor(npW, ftpW);
  if (intensity == null || ftpW == null) return null;
  return ((durationS * npW * intensity) / (ftpW * 3600)) * 100;
}

/**
 * Best average power (W, rounded) for each duration, over a 1 Hz series.
 * Durations longer than the series are skipped. Prefix sums make each
 * duration a single O(n) pass.
 */
export function meanMaxCurve(
  series: readonly number[],
  durations: readonly number[] = POWER_CURVE_DURATIONS_S,
): PowerCurvePoint[] {
  const prefix = new Float64Array(series.length + 1);
  for (let i = 0; i < series.length; i++) {
    prefix[i + 1] = prefix[i]! + series[i]!;
  }
  const curve: PowerCurvePoint[] = [];
  for (const d of durations) {
    if (d < 1 || d > series.length) continue;
    let best = 0;
    for (let i = 0; i + d <= series.length; i++) {
      const sum = prefix[i + d]! - prefix[i]!;
      if (sum > best) best = sum;
    }
    curve.push({ durationS: d, watts: Math.round(best / d) });
  }
  return curve;
}

const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/**
 * Every derived metric for one ride's DEVICE watts stream. Null when the
 * stream is too short for NP (under NP_WINDOW_S active seconds). `ftpW` is
 * the FTP in force on the ride date (lib/athleteProfile.ts ftpOn); without
 * it NP, the curve and the summary are still computed, IF/TSS are null.
 */
export function computeRidePowerMetrics(
  timeS: readonly number[],
  watts: readonly (number | null)[],
  ftpW: number | null,
): RidePowerMetrics | null {
  const series = resampleTo1Hz(timeS, watts);
  const np = normalizedPower(series);
  if (np == null) return null;

  let sum = 0;
  let max = 0;
  for (const w of series) {
    sum += w;
    if (w > max) max = w;
  }
  const intensity = intensityFactor(np, ftpW);
  const stress = trainingStressScore(series.length, np, ftpW);
  return {
    npW: Math.round(np),
    intensityFactor: intensity == null ? null : round(intensity, 3),
    tss: stress == null ? null : round(stress, 1),
    ftpW: intensity == null ? null : ftpW,
    durationS: series.length,
    avgPowerW: Math.round(sum / series.length),
    maxPowerW: Math.round(max),
    kilojoules: round(sum / 1000, 1),
    curve: meanMaxCurve(series),
  };
}

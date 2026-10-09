// Pure race-time prediction (Riegel + Daniels VDOT), DB-free + unit-tested.
// Premium-Parity #2: predicted race times for 1k/5k/10k/half/marathon (+ a 70k
// extrapolation). Strava has no such feature at all (docs/strava-benchmark.md),
// so this is net-new — no ground truth to match, just physiologically sound
// models made transparent.
//
// Two independent models, reported side by side:
//
//   Riegel power law   T2 = T1·(D2/D1)^k. The exponent k is the athlete's
//                      endurance "fade": higher k = pace drops off faster with
//                      distance. We RECALIBRATE k from the athlete's OWN
//                      best-effort pairs (a log-log least-squares fit) instead of
//                      the generic 1.06 — that self-personalization is the win
//                      Strava/Garmin can't show transparently. Generic k=1.06 is
//                      the fallback (too few pairs) and a reported baseline.
//
//   Daniels VDOT       An effective VO2max from a performance, then the equivalent
//                      time at another distance (velocity→VO2, times %VO2max
//                      sustainable for the duration). Cross-checks Riegel and the
//                      athlete's measured VO2max.
//
// Credit GoldenCheetah (GPL-3.0) and Jack Daniels' *Daniels' Running Formula* for
// the models — formulas only, no code copied (CREDITS.md #1, #9). Riegel (1981)
// and the Daniels–Gilbert VO2 relations are published formulas, free to use.

export interface EffortPair {
  distanceM: number;
  timeS: number;
}

/** Generic Riegel fatigue exponent (Riegel 1981, endurance-events average). */
export const GENERIC_RIEGEL_K = 1.06;

// ── Riegel: self-calibrated power law ─────────────────────────────────────────

export interface RiegelFit {
  /** Fatigue exponent (regression slope in log-log space). */
  k: number;
  /** Multiplier a in T = a·D^k (D in metres, T in seconds). */
  a: number;
  /** Coefficient of determination of the log-log fit (0..1). */
  r2: number;
  /** Number of pairs the fit used. */
  n: number;
  /** True when the generic exponent was used (too few pairs). */
  fallback: boolean;
}

/**
 * Fit T = a·D^k to best-effort pairs by ordinary least squares on ln T vs ln D.
 * With fewer than `minPairs` (default 3) usable pairs, falls back to the generic
 * exponent and derives `a` from the median of the available pairs. Returns null
 * only when there are no usable pairs at all.
 */
export function fitRiegel(
  pairs: EffortPair[],
  minPairs = 3,
): RiegelFit | null {
  const pts = pairs.filter((p) => p.distanceM > 0 && p.timeS > 0);
  if (pts.length === 0) return null;

  if (pts.length < minPairs) {
    // Fallback: generic k, a = median(T / D^k) so predictions still honour the
    // athlete's actual speed level.
    const k = GENERIC_RIEGEL_K;
    const as = pts.map((p) => p.timeS / Math.pow(p.distanceM, k)).sort((x, y) => x - y);
    const a = as[Math.floor(as.length / 2)]!;
    return { k, a, r2: 0, n: pts.length, fallback: true };
  }

  const xs = pts.map((p) => Math.log(p.distanceM));
  const ys = pts.map((p) => Math.log(p.timeS));
  const n = pts.length;
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const k = sxy / sxx; // slope
  const lnA = meanY - k * meanX; // intercept
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy);
  return { k, a: Math.exp(lnA), r2, n, fallback: false };
}

/** Predicted time (s) for a distance under a fitted power law. */
export function riegelFromFit(fit: RiegelFit, distanceM: number): number {
  return fit.a * Math.pow(distanceM, fit.k);
}

/** Classic Riegel projection from a single reference effort with a given k. */
export function riegelFromAnchor(
  anchor: EffortPair,
  distanceM: number,
  k: number = GENERIC_RIEGEL_K,
): number {
  return anchor.timeS * Math.pow(distanceM / anchor.distanceM, k);
}

// ── Daniels VDOT ──────────────────────────────────────────────────────────────
// Daniels–Gilbert relations (Daniels' Running Formula). v in m/min, t in min.

/** Oxygen cost (ml/kg/min) of running at velocity v (m/min). */
export function velocityToVo2(vMetersPerMin: number): number {
  return -4.6 + 0.182258 * vMetersPerMin + 0.000104 * vMetersPerMin * vMetersPerMin;
}

/** Fraction of VO2max sustainable for an effort of duration t (minutes). */
export function pctVo2maxForDuration(tMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * tMin) +
    0.2989558 * Math.exp(-0.1932605 * tMin)
  );
}

/** VDOT (effective VO2max) implied by covering distanceM in timeS. */
export function vdotFromPerformance(distanceM: number, timeS: number): number {
  const tMin = timeS / 60;
  const v = distanceM / tMin;
  return velocityToVo2(v) / pctVo2maxForDuration(tMin);
}

/**
 * Invert Daniels: the time (s) to cover distanceM at a given VDOT. For a fixed
 * distance, VDOT is monotonically decreasing in time (slower = easier relative to
 * capacity), so bisect on time. Bracket 0.3–1000 min; returns null if the target
 * VDOT lies outside the achievable range on that bracket.
 */
export function timeForVdot(distanceM: number, vdot: number): number | null {
  const g = (tMin: number): number => vdotFromPerformance(distanceM, tMin * 60) - vdot;
  let lo = 0.3; // ~18 s, faster than any human — high VDOT
  let hi = 1000; // ~16.7 h — very low VDOT
  const gLo = g(lo);
  const gHi = g(hi);
  if (gLo === 0) return lo * 60;
  if (gHi === 0) return hi * 60;
  if (gLo > 0 === gHi > 0) return null; // target VDOT not bracketed
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const gm = g(mid);
    if (gm > 0) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}

export interface VdotReference {
  vdot: number;
  from: EffortPair;
}

/**
 * The athlete's reference VDOT: the highest VDOT among efforts whose duration
 * falls in the window the Daniels model is valid for (default 3.5–60 min — short
 * sprints and ultra-long efforts distort the % VO2max relation). This is the
 * anchor for VDOT-based predictions and the generic-Riegel baseline. Null if no
 * effort qualifies.
 */
export function referenceVdot(
  pairs: EffortPair[],
  minDurationS = 210,
  maxDurationS = 3600,
): VdotReference | null {
  let best: VdotReference | null = null;
  for (const p of pairs) {
    if (p.distanceM <= 0 || p.timeS < minDurationS || p.timeS > maxDurationS) continue;
    const vdot = vdotFromPerformance(p.distanceM, p.timeS);
    if (!best || vdot > best.vdot) best = { vdot, from: p };
  }
  return best;
}

// ── Error band ────────────────────────────────────────────────────────────────

/**
 * Half-width of the prediction band, as a fraction of the predicted time. A
 * small base uncertainty for interpolation, growing with how far the target is
 * extrapolated beyond the longest available effort (Riegel/VDOT degrade badly
 * past the data — CLAUDE.md flags the 70k as an extrapolation with wide bands).
 */
export function bandFraction(distanceM: number, maxEffortM: number): number {
  const base = 0.03;
  if (distanceM <= maxEffortM) return base;
  return base + 0.12 * Math.log(distanceM / maxEffortM);
}

// ── Top-level ─────────────────────────────────────────────────────────────────

export interface RaceTarget {
  label: string;
  distanceM: number;
}

/** The standard prediction set (CLAUDE.md Premium-Parity #2). */
export const DEFAULT_TARGETS: RaceTarget[] = [
  { label: '1K', distanceM: 1000 },
  { label: '5K', distanceM: 5000 },
  { label: '10K', distanceM: 10000 },
  { label: 'Half-Marathon', distanceM: 21097 },
  { label: 'Marathon', distanceM: 42195 },
  { label: '70K', distanceM: 70000 },
];

export interface RacePrediction {
  label: string;
  distanceM: number;
  /** Headline prediction (s): the self-calibrated Riegel power law. */
  predictedS: number;
  /** Riegel with the athlete's own fitted exponent (= predictedS). */
  riegelSelfS: number;
  /** Riegel with the generic 1.06 exponent from the reference effort. */
  riegelGenericS: number | null;
  /** Daniels VDOT equivalent from the reference effort. */
  vdotS: number | null;
  /** Lower/upper band around the headline prediction (s). */
  lowS: number;
  highS: number;
  bandPct: number;
  /** True when the target is longer than every best effort (extrapolated). */
  extrapolated: boolean;
}

export interface RacePredictionResult {
  fit: RiegelFit | null;
  vdotRef: VdotReference | null;
  maxEffortM: number;
  predictions: RacePrediction[];
}

/**
 * Predict race times for a set of target distances from best-effort pairs.
 * Headline = self-calibrated Riegel; generic-Riegel and VDOT reported alongside
 * as cross-checks. Bands widen for extrapolated (> longest effort) targets.
 */
export function predictRaces(
  pairs: EffortPair[],
  targets: RaceTarget[] = DEFAULT_TARGETS,
): RacePredictionResult {
  const usable = pairs.filter((p) => p.distanceM > 0 && p.timeS > 0);
  const fit = fitRiegel(usable);
  const vdotRef = referenceVdot(usable);
  const maxEffortM = usable.reduce((m, p) => Math.max(m, p.distanceM), 0);

  const predictions: RacePrediction[] = targets.map((t) => {
    const riegelSelfS = fit ? Math.round(riegelFromFit(fit, t.distanceM)) : 0;
    const riegelGenericS = vdotRef
      ? Math.round(riegelFromAnchor(vdotRef.from, t.distanceM, GENERIC_RIEGEL_K))
      : null;
    const vRaw = vdotRef ? timeForVdot(t.distanceM, vdotRef.vdot) : null;
    const vdotS = vRaw != null ? Math.round(vRaw) : null;
    const bandPct = bandFraction(t.distanceM, maxEffortM);
    return {
      label: t.label,
      distanceM: t.distanceM,
      predictedS: riegelSelfS,
      riegelSelfS,
      riegelGenericS,
      vdotS,
      lowS: Math.round(riegelSelfS * (1 - bandPct)),
      highS: Math.round(riegelSelfS * (1 + bandPct)),
      bandPct: Math.round(bandPct * 1000) / 1000,
      extrapolated: t.distanceM > maxEffortM,
    };
  });

  return { fit, vdotRef, maxEffortM, predictions };
}

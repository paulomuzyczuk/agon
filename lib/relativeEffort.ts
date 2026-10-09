// Pure Relative Effort (per-activity training-load score), DB-free + unit-tested.
// Agon's reimplementation of Strava's paywalled "Relative Effort" (Premium-Parity
// #7), which Strava itself credits to Dr. Eric Banister's TRIMP (Training Impulse).
//
// TRIMP scores a session by heart rate relative to the athlete's reserve, weighted
// by time: longer + harder → higher. We use the Banister exponential weighting:
//
//   HRr    = (HR − HR_rest) / (HR_max − HR_rest)          heart-rate reserve fraction, clamped 0..1
//   weight = HRr · 0.64 · e^(1.92·HRr)                    (male coefficients)
//   TRIMP  = Σ  Δt_min · weight(HRr(t))                   integrated over the session
//
// Two entry points: the accurate stream-integrated form (uses the whole HR series
// in run_streams — better than Strava, which has only an average for many
// sessions) and an average-HR fallback for runs with no stream. Credit
// GoldenCheetah/sweatpy for the model; formula only, no code copied.

export interface HrAnchors {
  /** Resting HR (bpm). */
  hrRest: number;
  /** Max HR (bpm). */
  hrMax: number;
}

/** Female coefficients differ; the athlete is male (CLAUDE.md Athlete Profile). */
const TRIMP_K = 0.64;
const TRIMP_EXP = 1.92;

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Heart-rate reserve fraction (0..1) for a raw HR, clamped to the valid range. */
export function hrReserveFraction(
  hr: number,
  { hrRest, hrMax }: HrAnchors,
): number {
  if (hrMax <= hrRest) return 0; // guard against bad anchors
  return clamp01((hr - hrRest) / (hrMax - hrRest));
}

/** Banister TRIMP intensity weight for a heart-rate reserve fraction (0..1). */
export function trimpWeight(hrReserve: number): number {
  const y = clamp01(hrReserve);
  return y * TRIMP_K * Math.exp(TRIMP_EXP * y);
}

export interface StreamTrimpOptions extends HrAnchors {
  /**
   * Cap on a single inter-sample interval, in seconds. A larger gap means the
   * device paused (or dropped out); counting the full gap as effort would inflate
   * the score, so it's clamped to this. Default 30 s (HR samples every ~1–3 s).
   */
  maxSampleGapS?: number;
}

/**
 * Stream-integrated TRIMP over an index-aligned (timeS, heartrate) series.
 * `heartrate` may contain nulls (sensor dropouts); an interval is scored from the
 * mean of its two endpoints when both are present, else the single present value,
 * and skipped when both are null. Returns null when there aren't two usable
 * samples (caller should fall back to the average form).
 */
export function relativeEffortFromStream(
  timeS: number[],
  heartrate: Array<number | null>,
  opts: StreamTrimpOptions,
): number | null {
  const maxGap = opts.maxSampleGapS ?? 30;
  if (timeS.length < 2) return null;

  let trimp = 0;
  let scoredIntervals = 0;
  for (let i = 1; i < timeS.length; i++) {
    const dtRaw = timeS[i]! - timeS[i - 1]!;
    if (dtRaw <= 0) continue; // non-increasing axis — skip
    const dt = Math.min(dtRaw, maxGap);

    const a = heartrate[i - 1];
    const b = heartrate[i];
    let hr: number | null = null;
    if (a != null && b != null) hr = (a + b) / 2;
    else if (a != null) hr = a;
    else if (b != null) hr = b;
    if (hr == null) continue; // both endpoints missing

    trimp += (dt / 60) * trimpWeight(hrReserveFraction(hr, opts));
    scoredIntervals++;
  }
  if (scoredIntervals === 0) return null;
  return round1(trimp);
}

/**
 * Average-HR fallback: a single TRIMP over the whole session from its average HR
 * and duration. Used when a run has avg HR but no usable HR stream. Returns null
 * for a non-positive duration.
 */
export function relativeEffortFromAverage(
  durationS: number,
  avgHr: number,
  anchors: HrAnchors,
): number | null {
  if (durationS <= 0) return null;
  const trimp =
    (durationS / 60) * trimpWeight(hrReserveFraction(avgHr, anchors));
  return round1(trimp);
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

// ── Pace→HR surrogate (last-resort load for runs with NO HR at all) ───────────
// Some runs have neither an HR stream nor an average HR (chest-strap-less, and no
// manual estimate). Without HR they would score no TRIMP at all and contribute 0
// to training load — indistinguishable from a rest day (the June 2026 artifact).
// As a LAST RESORT we estimate an average HR from the run's average pace using a
// linear model fit to the athlete's OWN measured (pace, HR) runs, then feed that
// estimate through the ordinary average-HR TRIMP form. The score is labeled
// method='estimated_pace' so it stays transparently the lowest-fidelity tier.
//
// Fit is HR = a + b·speed (speed in m/s): running HR rises ~linearly with speed
// over the aerobic range. The caller supplies measured pairs (its own data), so
// this is athlete-specific and self-recalibrating, like the Riegel exponent and
// the sweat-rate baseline elsewhere in Agon.

/** Minimum measured pairs required to trust a pace→HR fit. */
export const PACE_HR_MIN_PAIRS = 8;

/** One measured (average-pace, average-HR) observation used to fit the model. */
export interface PaceHrPair {
  /** Average speed of the run, metres per second. */
  speedMps: number;
  /** Measured average HR (bpm). */
  hr: number;
}

/** A fitted linear pace→HR model: HR ≈ a + b·speedMps. */
export interface PaceHrModel {
  /** Intercept (bpm). */
  a: number;
  /** Slope (bpm per m/s). */
  b: number;
  /** Number of pairs the fit used. */
  n: number;
  /** Coefficient of determination (0..1) — how well pace explains HR here. */
  r2: number;
}

/**
 * Ordinary-least-squares fit of HR = a + b·speed over measured (speed, HR) pairs.
 * Returns null when there are too few pairs or pace has no variance (a fit would
 * be meaningless). The caller is responsible for filtering out implausible pairs
 * (e.g. sensor-dropout averages) before fitting.
 */
export function fitPaceHrModel(pairs: PaceHrPair[]): PaceHrModel | null {
  const pts = pairs.filter(
    (p) =>
      Number.isFinite(p.speedMps) && Number.isFinite(p.hr) && p.speedMps > 0,
  );
  const n = pts.length;
  if (n < PACE_HR_MIN_PAIRS) return null;

  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += p.speedMps;
    sy += p.hr;
  }
  const mx = sx / n;
  const my = sy / n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    const dx = p.speedMps - mx;
    const dy = p.hr - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  if (sxx === 0) return null; // no pace variance — can't fit a slope

  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { a, b, n, r2 };
}

/**
 * Estimated average HR (bpm) for a given speed under the fitted model, clamped to
 * the athlete's [HR_rest, HR_max] so out-of-domain paces (walks, sprints) can't
 * produce a physiologically-impossible HR.
 */
export function estimateHrFromPace(
  speedMps: number,
  model: PaceHrModel,
  { hrRest, hrMax }: HrAnchors,
): number {
  const raw = model.a + model.b * speedMps;
  return raw < hrRest ? hrRest : raw > hrMax ? hrMax : raw;
}

/** A pace-derived Relative Effort score plus the HR it was estimated from. */
export interface PaceEffort {
  /** TRIMP score, comparable to the stream/average methods. */
  score: number;
  /** The HR (bpm) estimated from pace and used for the score (for provenance). */
  estimatedHr: number;
}

/**
 * Last-resort Relative Effort from average pace: estimate HR from the run's mean
 * speed (distance/duration) via the fitted model, then apply the average-HR TRIMP
 * form. Returns null for a non-positive duration/distance.
 */
export function relativeEffortFromPace(
  durationS: number,
  distanceKm: number,
  model: PaceHrModel,
  anchors: HrAnchors,
): PaceEffort | null {
  if (durationS <= 0 || distanceKm <= 0) return null;
  const speedMps = (distanceKm * 1000) / durationS;
  if (!Number.isFinite(speedMps) || speedMps <= 0) return null;
  const estimatedHr = estimateHrFromPace(speedMps, model, anchors);
  const score = relativeEffortFromAverage(durationS, estimatedHr, anchors);
  if (score == null) return null;
  return { score, estimatedHr: Math.round(estimatedHr) };
}

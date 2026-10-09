// Pure moving-vs-paused time from a run's GPS stream, DB-free + unit-tested.
// Strava's `moving` stream (services/strava/streams.ts -> run_streams.moving)
// flags detected stops (e.g. forced stops at red lights) sample-by-sample;
// most other sources (Fitbit HR-only, Google Health TCX) don't carry it, so
// this only ever applies to Strava-sourced streams.
//
// Live data check (2026-09-05) found the raw flag is noisy: one otherwise
// continuous 62-minute run flickered `moving=false` for a single sample 780
// times (GPS/algorithm noise, not real stops), summing to ~93s of genuinely
// contiguous stop time but ~872s of raw flagged samples if every flicker were
// treated as a real pause. Everything here therefore only ever acts on a
// CONFIRMED stop — a contiguous false-run lasting >= MIN_STOP_S — never on an
// isolated flagged sample.
//
// Built to answer "how would this run have paced without forced stops" — a
// real gap between a run's raw elapsed time (what Strava's own best_efforts
// and Agon's sliding-window search both use) and how it felt to run.

const MIN_STOP_S = 5;
const RECOVERY_WINDOW_S = 90;

export interface NetPaceOptions {
  /** Minimum contiguous stop duration (s) counted as real — filters flicker noise. Default 5. */
  minStopS?: number;
  /** Window after resuming from a stop treated as rest-boosted (s). Default 90. */
  recoveryWindowS?: number;
}

export interface ConfirmedStop {
  /** First sample index flagged stopped. */
  stopStart: number;
  /** First moving sample after the stop (always < n — a trailing, never-resumed stop isn't confirmed here). */
  resumeIdx: number;
}

/**
 * Contiguous false-runs in `moving` lasting >= minStopS. A trailing stop the
 * run never resumes from (recording ends mid-stop) is never confirmed — there
 * is no "after" to correct anything against. Exported for comparing two
 * moving-flag sources at the confirmed-stop level (see compareConfirmedStops).
 *
 * "Lasting" is either span, whichever is longer: first stopped → first
 * moving sample (the original rule), or the span a confirmed stop actually
 * freezes (see frozenIndexSet — the intervals ENDING on each stopped sample,
 * timeS[stopStart-1] → timeS[resumeIdx-1]). The original rule alone skips
 * the dt leading INTO the stop, so a recording gap landing on a lone stopped
 * sample (Strava auto-pause, GPS dropout) looked like a ~1 s flicker and the
 * whole gap was counted as moving (MZY-217, live: a 1898 s gap on the
 * 2026-07-26 run). On evenly-sampled data the two spans are equal, so
 * flicker gating is unchanged; taking the longer one means a stop the
 * original rule confirmed is never un-confirmed — the only new stops are
 * ones with a long interval leading into them.
 */
export function findConfirmedStops(
  timeS: number[],
  moving: Array<boolean | null>,
  minStopS: number,
): ConfirmedStop[] {
  const n = timeS.length;
  const stops: ConfirmedStop[] = [];
  let i = 0;
  while (i < n) {
    if (moving[i] !== false) {
      i++;
      continue;
    }
    const stopStart = i;
    while (i < n && moving[i] === false) i++;
    const resumeIdx = i;
    if (resumeIdx >= n) break;
    const flaggedSpanS = timeS[resumeIdx]! - timeS[stopStart]!;
    const frozenSpanS = stopStart > 0 ? timeS[resumeIdx - 1]! - timeS[stopStart - 1]! : 0;
    if (Math.max(flaggedSpanS, frozenSpanS) < minStopS) continue;
    stops.push({ stopStart, resumeIdx });
  }
  return stops;
}

/** Marks every sample index that belongs to a confirmed stop's paused range. */
function frozenIndexSet(n: number, stops: ConfirmedStop[]): boolean[] {
  const frozen = new Array<boolean>(n).fill(false);
  for (const s of stops) for (let k = s.stopStart; k < s.resumeIdx; k++) frozen[k] = true;
  return frozen;
}

export interface MovingTimeResult {
  /** Total elapsed time actually moving (s). */
  movingTimeS: number;
  /** Total elapsed time NOT moving — confirmed stops (s). */
  pausedTimeS: number;
}

/**
 * Sums elapsed time over (timeS, moving) into moving vs. paused, counting
 * only CONFIRMED (>= minStopS) stops as paused — an isolated flagged sample
 * shorter than that is treated as moving (noise, not a real pause).
 * Returns null for too-short or mismatched-length input.
 */
export function computeMovingTime(
  timeS: number[],
  moving: Array<boolean | null>,
  opts: NetPaceOptions = {},
): MovingTimeResult | null {
  const minStopS = opts.minStopS ?? MIN_STOP_S;
  const n = timeS.length;
  if (n < 2 || moving.length !== n) return null;

  const frozen = frozenIndexSet(n, findConfirmedStops(timeS, moving, minStopS));
  let movingTimeS = 0;
  let totalTimeS = 0;
  for (let i = 1; i < n; i++) {
    const dt = timeS[i]! - timeS[i - 1]!;
    if (dt <= 0) continue;
    totalTimeS += dt;
    if (!frozen[i]) movingTimeS += dt;
  }
  if (totalTimeS <= 0) return null;
  return { movingTimeS, pausedTimeS: totalTimeS - movingTimeS };
}

// ── Estimated net pace ──────────────────────────────────────────────────────
// distance/movingTime (the naive estimate) assumes you'd hold your ACTUAL
// post-stop pace even without the stop — but that pace was partly earned by
// the rest a forced stop gives (HR drops, legs recover, then you take off
// fresh). Remove the stop and you also remove the recovery, so a genuinely
// continuous effort lands somewhere between raw elapsed (charges the full
// stopped time as if still working — pessimistic) and naive moving pace
// (assumes zero fatigue cost from the missing rest — optimistic).
//
// Model: for each CONFIRMED stop, treat the RECOVERY_WINDOW_S right after
// resuming as rest-boosted (clipped at the next confirmed stop, so
// closely-spaced stops never have overlapping windows). Compute the run's own
// baseline pace from every OTHER moving sample (excluding confirmed stops and
// every recovery window). Then, PER STOP independently, compare that stop's
// own recovery-window pace against the (shared) baseline: if it was FASTER —
// the boost — re-price just that window's distance at the baseline pace
// instead, and charge the difference back as time. A window that wasn't
// actually faster costs nothing (penalty only, never a bonus, mirroring
// services/routing/weather.ts's wind-exposure discipline) — this only ever
// pulls net pace toward elapsed, never past naive moving pace in the other
// direction. Deciding per stop (not pooling every window into one average)
// means one genuine boost after an early light doesn't get diluted — or a
// non-boost after a later one doesn't get inflated — by how the other stops
// in the same run happened to go.
//
// This is a heuristic, not a physiological model: it doesn't use HR (kept
// distance/time-only for streams that lack it) and doesn't model recovery
// kinetics within the window, just "was this bit faster than normal."

interface StopWindow {
  /** First sample index of the recovery window (the resume sample itself). */
  resumeIdx: number;
  /** One past the last sample index in the window (exclusive), clipped at the next confirmed stop. */
  endIdxExclusive: number;
}

/** Extends each confirmed stop's resume point into a recovery window, clipped at the next stop. */
function buildRecoveryWindows(
  timeS: number[],
  stops: ConfirmedStop[],
  recoveryWindowS: number,
): StopWindow[] {
  const n = timeS.length;
  return stops.map((stop, idx) => {
    const windowEndTime = timeS[stop.resumeIdx]! + recoveryWindowS;
    const nextStopStart = stops[idx + 1]?.stopStart ?? n;
    let j = stop.resumeIdx;
    while (j < nextStopStart && timeS[j]! <= windowEndTime) j++;
    return { resumeIdx: stop.resumeIdx, endIdxExclusive: j };
  });
}

/** Sum of elapsed time/distance over a contiguous index range [start, endExclusive). */
function sumRange(
  timeS: number[],
  distanceM: number[],
  start: number,
  endExclusive: number,
): { timeS: number; distanceM: number } {
  let t = 0;
  let d = 0;
  for (let k = start; k < endExclusive; k++) {
    const dt = timeS[k]! - timeS[k - 1]!;
    if (dt <= 0) continue;
    t += dt;
    d += Math.max(0, distanceM[k]! - distanceM[k - 1]!);
  }
  return { timeS: t, distanceM: d };
}

export interface NetAdjustedStream {
  /** Same length/alignment as the input. */
  timeS: number[];
  /** Same length/alignment as the input. */
  distanceM: number[];
  /** Total time charged back across every boosted window (s). */
  recoveryBonusS: number;
  /** Confirmed (>= minStopS) forced stops found. */
  stopsCounted: number;
}

/**
 * Builds a corrected (time, distance) STREAM PAIR, index-aligned with the
 * original: a CONFIRMED stop's interval freezes BOTH time and distance
 * together (not just time) — critical, because a stop-flagged sample can
 * still show a sliver of GPS drift/jitter in `distanceM`; crediting that
 * drift at zero elapsed time would let a sliding-window search string
 * together an impossible near-instant "PR" (caught live: a naive time-only
 * version of this produced a 1-second 1K). Freezing both dimensions together
 * means every distance increment this function ever reports is paired with
 * AT LEAST its real elapsed time — never less — so nothing downstream can go
 * faster than what was actually recorded. An UNCONFIRMED flicker (below
 * minStopS) is left alone entirely, same as computeMovingTime.
 *
 * A recovery-window interval that beat the run's baseline pace has its time
 * stretched back to that baseline pace (distance unchanged — the measurement
 * itself isn't in question, only whether the pace was rest-boosted).
 *
 * Feed the result directly into lib/bestEfforts.ts's findBestEffort/
 * fullStreamEffort in place of the raw stream — that code needs no changes,
 * it just reads a different (time, distance) pairing for the same run.
 * Returns null for too-short or mismatched-length input.
 */
export function buildNetAdjustedStream(
  timeS: number[],
  distanceM: number[],
  moving: Array<boolean | null>,
  opts: NetPaceOptions = {},
): NetAdjustedStream | null {
  const minStopS = opts.minStopS ?? MIN_STOP_S;
  const recoveryWindowS = opts.recoveryWindowS ?? RECOVERY_WINDOW_S;
  const n = timeS.length;
  if (n < 2 || distanceM.length !== n || moving.length !== n) return null;

  const confirmedStops = findConfirmedStops(timeS, moving, minStopS);
  const stopsCounted = confirmedStops.length;
  const frozen = frozenIndexSet(n, confirmedStops);
  const windows = buildRecoveryWindows(timeS, confirmedStops, recoveryWindowS);

  const inAnyWindow = new Array<boolean>(n).fill(false);
  for (const w of windows) for (let k = w.resumeIdx; k < w.endIdxExclusive; k++) inAnyWindow[k] = true;

  let baselineTimeS = 0;
  let baselineDistM = 0;
  for (let k = 1; k < n; k++) {
    const dt = timeS[k]! - timeS[k - 1]!;
    if (dt <= 0 || frozen[k] || inAnyWindow[k]) continue;
    baselineTimeS += dt;
    baselineDistM += Math.max(0, distanceM[k]! - distanceM[k - 1]!);
  }
  const baselinePaceSPerM = baselineDistM > 0 ? baselineTimeS / baselineDistM : null;

  // Per-stop decision: only a window that beat the baseline gets re-priced.
  const boosted = new Set<StopWindow>();
  let recoveryBonusS = 0;
  if (baselinePaceSPerM != null) {
    for (const w of windows) {
      const { timeS: wT, distanceM: wD } = sumRange(timeS, distanceM, w.resumeIdx, w.endIdxExclusive);
      if (wD <= 0 || wT <= 0) continue;
      if (wT / wD < baselinePaceSPerM) {
        boosted.add(w);
        recoveryBonusS += wD * baselinePaceSPerM - wT;
      }
    }
  }

  const boostedWindowFor = (k: number): boolean => {
    for (const w of windows) {
      if (boosted.has(w) && k >= w.resumeIdx && k < w.endIdxExclusive) return true;
    }
    return false;
  };

  const adjTimeS = new Array<number>(n);
  const adjDistanceM = new Array<number>(n);
  adjTimeS[0] = timeS[0]!;
  adjDistanceM[0] = distanceM[0]!;
  for (let k = 1; k < n; k++) {
    const dt = timeS[k]! - timeS[k - 1]!;
    if (dt <= 0 || frozen[k]) {
      // Frozen: no time, no distance progress credited — the pairing that
      // closes the free-distance exploit.
      adjTimeS[k] = adjTimeS[k - 1]!;
      adjDistanceM[k] = adjDistanceM[k - 1]!;
      continue;
    }
    const dd = Math.max(0, distanceM[k]! - distanceM[k - 1]!);
    adjTimeS[k] =
      adjTimeS[k - 1]! + (baselinePaceSPerM != null && boostedWindowFor(k) ? dd * baselinePaceSPerM : dt);
    adjDistanceM[k] = adjDistanceM[k - 1]! + dd;
  }

  return { timeS: adjTimeS, distanceM: adjDistanceM, recoveryBonusS, stopsCounted };
}

export interface NetTimeResult {
  /** Moving time, with any rest-boosted recovery windows re-priced at baseline pace (s). */
  netTimeS: number;
  /** Time charged back for boosted recovery windows (s) — 0 if none were faster than baseline. */
  recoveryBonusS: number;
  /** Confirmed (>= minStopS) forced stops found. */
  stopsCounted: number;
}

/**
 * Estimated net time as a scalar summary — see buildNetAdjustedStream for the
 * underlying model. Returns null for too-short or mismatched-length input.
 */
export function estimateNetTime(
  timeS: number[],
  distanceM: number[],
  moving: Array<boolean | null>,
  opts: NetPaceOptions = {},
): NetTimeResult | null {
  const adjusted = buildNetAdjustedStream(timeS, distanceM, moving, opts);
  if (!adjusted) return null;
  const netTimeS = adjusted.timeS[adjusted.timeS.length - 1]! - adjusted.timeS[0]!;
  return { netTimeS, recoveryBonusS: adjusted.recoveryBonusS, stopsCounted: adjusted.stopsCounted };
}

// ── In-house derived moving flag ────────────────────────────────────────────
// Confirmed 2026-09-05 (CLAUDE.md): Strava's own per-sample `moving` flag is
// exclusive to its paywalled Streams API — a free GPX/TCX export never carries
// it, so every non-Strava-API stream (Google Health, any file import) can
// never benefit from computeMovingTime/estimateNetTime at all without one.
// This derives an in-house equivalent from data every distance-bearing stream
// already has: instantaneous speed (distance/time between consecutive
// samples) below a threshold means "not moving." Stored separately
// (run_streams.derived_moving) from the real `moving` column so the two can
// always be compared where both exist, rather than one silently overwriting
// the other.
//
// Like Strava's own flag (confirmed noisy — see the module doc above), the
// raw per-sample output here is expected to flicker on GPS jitter too; it
// deliberately gets NO smoothing of its own, because every consumer
// (computeMovingTime, buildNetAdjustedStream) already filters flicker via the
// same confirmed-stop (>= minStopS) gate. Comparing raw flags AND
// confirmed-stop-level detections against Strava's real data (see
// compareMovingFlags / compareConfirmedStops) is what validates this instead
// of just asserting it.

/**
 * Speed (m/s) below which a sample is considered stopped. Calibrated
 * 2026-09-05 against the 52 runs with real Strava `moving` data
 * (`pnpm dm:backfill`'s threshold sweep): 1.0 m/s (~3.6 km/h, at/below a slow
 * walk) gave the best confirmed-stop F1 (0.98 — recall 97.9%, precision
 * 97.7%), clearly ahead of lower thresholds (0.6 m/s: F1 0.93, recall only
 * 86.7% — misses real stops) and 1.2 m/s (F1 0.90 — precision drops to 82.8%,
 * starts flagging genuine slow jogging as stopped).
 */
export const DEFAULT_STOP_SPEED_MPS = 1.0;

export interface DeriveMovingOptions {
  /** Speed threshold (m/s) below which a sample is flagged stopped. Default DEFAULT_STOP_SPEED_MPS. */
  stopSpeedMps?: number;
}

/**
 * Per-sample moving flag derived from instantaneous speed (distance/time
 * between consecutive samples). The first sample has no prior point to
 * compute a speed from and defaults to moving (consistent with the
 * unknown-means-moving convention used elsewhere in this module). Returns
 * null for too-short or mismatched-length input.
 *
 * Known limitation (MZY-218): across a recording gap the only speed there is
 * is the gap's average, so the post-gap sample is judged on it. Checked
 * against every >10 s gap in the local data (115, all Strava): this agrees
 * with Strava's own flag on 114. The one miss (2026-07-26, a 1898 s walk at
 * 1.03 m/s, Strava: stopped) is indistinguishable in the stream from gaps
 * Strava counts as moving (2026-08-08: 33 s at 1.1 m/s) — Strava's call there
 * reflects its recorder's pause state, which no stream carries. Deliberately
 * left unfixed rather than fitted to two data points.
 */
export function deriveMovingFlags(
  timeS: number[],
  distanceM: number[],
  opts: DeriveMovingOptions = {},
): boolean[] | null {
  const stopSpeedMps = opts.stopSpeedMps ?? DEFAULT_STOP_SPEED_MPS;
  const n = timeS.length;
  if (n < 2 || distanceM.length !== n) return null;

  const flags = new Array<boolean>(n);
  flags[0] = true;
  for (let k = 1; k < n; k++) {
    const dt = timeS[k]! - timeS[k - 1]!;
    if (dt <= 0) {
      flags[k] = flags[k - 1]!; // no time info for this sample — inherit
      continue;
    }
    const dd = Math.max(0, distanceM[k]! - distanceM[k - 1]!);
    flags[k] = dd / dt >= stopSpeedMps;
  }
  return flags;
}

// ── Cadence-derived moving flag (independent second opinion) ───────────────
// deriveMovingFlags (above) and Strava's own real `moving` flag both ultimately
// come from the SAME underlying signal — GPS-derived speed/position — so
// agreement between them isn't fully independent evidence; it just means two
// algorithms looked at the same raw track and reached similar conclusions.
// Cadence is mechanically unrelated: it's the accelerometer-measured stride
// rate, with no dependency on GPS position, speed smoothing, or distance
// calculation at all. Built deliberately WITHOUT reference to Strava's flag —
// the threshold below comes only from the cadence data's own distribution
// (a real gap between near-zero and running-cadence samples), so a comparison
// against both the speed-based method AND Strava's flag afterward is a
// genuine cross-check, not a rerun of the same idea calibrated the same way.
//
// Coverage caveat: cadence is only present on some Strava-sourced streams
// (24 of 52 in the live dataset) and the one Strava GPX export attached so
// far — Fitbit and most Google Health streams don't carry it at all.
//
// Signal-quality caveat: the athlete runs with a cellphone, not a wrist/foot
// sensor, so this cadence is whatever the phone's accelerometer picks up
// wherever it's carried (pocket/armband/hand) — much more loosely coupled to
// actual stride motion than a wrist-worn watch. Read comparisons against this
// signal with that in mind; see docs/methodology-log.md (2026-09-05) for the
// full cross-check and its unresolved noise-vs-genuine-difference question.

/**
 * Cadence (steps/min, one-foot convention — matches Garmin/Strava's `cad`
 * field) below which a sample is considered stopped. Picked from the live
 * dataset's own cadence histogram (110,889 samples across every stream that
 * has one): a sharp natural gap between a 0-9 spm cluster (2,544 samples —
 * genuinely stationary) and everything else (only 13 samples at 10-19 spm,
 * then a continuous ramp into the dominant 70-89 spm running cadence,
 * 100,000+ samples) — NOT calibrated against Strava's `moving` flag at all.
 */
export const DEFAULT_STOP_CADENCE_SPM = 15;

/**
 * Cadence (steps/min, BOTH-FEET total — Fitbit's `steps.count`, NOT the
 * one-foot convention DEFAULT_STOP_CADENCE_SPM uses) below which a Fitbit-wrist
 * sample is considered stopped. Picked from the Fitbit-wrist dataset's OWN
 * value distribution (`pnpm fc:backfill`, 50,740 covered samples across the 13
 * runs meeting the coverage gate): a clean gap with ZERO samples between 45-49
 * spm (60 samples) and 60-64 spm (180 samples) — the same "real gap between a
 * near-zero cluster and the running-cadence ramp" shape as
 * DEFAULT_STOP_CADENCE_SPM's calibration, just at roughly double the value
 * (expected: Fitbit counts both feet, the phone convention counts one). NOT
 * tuned against Strava's flag. See docs/methodology-log.md (2026-09-05,
 * "Fitbit-wrist cadence") for the full histogram and the coverage caveats
 * that limit which runs this can be evaluated on at all.
 */
export const DEFAULT_STOP_FITBIT_CADENCE_SPM = 50;

export interface DeriveMovingFromCadenceOptions {
  /** Cadence threshold (spm) below which a sample is flagged stopped. Default DEFAULT_STOP_CADENCE_SPM. */
  stopCadenceSpm?: number;
}

/**
 * Per-sample moving flag derived directly from cadence — no speed, distance,
 * or GPS involved at all. Null cadence (sensor dropout) defaults to moving,
 * same unknown-means-moving convention as the rest of this module. Returns
 * null for too-short or mismatched-length input.
 */
export function deriveMovingFlagsFromCadence(
  timeS: number[],
  cadence: Array<number | null>,
  opts: DeriveMovingFromCadenceOptions = {},
): boolean[] | null {
  const stopCadenceSpm = opts.stopCadenceSpm ?? DEFAULT_STOP_CADENCE_SPM;
  const n = timeS.length;
  if (n < 2 || cadence.length !== n) return null;
  return cadence.map((c) => c == null || c >= stopCadenceSpm);
}

export interface MovingFlagComparison {
  totalSamples: number;
  /** Both flags agree (moving or stopped). */
  agreeingSamples: number;
  truePositive: number; // both moving
  trueNegative: number; // both stopped
  falsePositive: number; // derived says stopped, real (Strava) says moving
  falseNegative: number; // derived says moving, real (Strava) says stopped
}

/**
 * Per-sample agreement between a derived flag and Strava's real one (treated
 * as ground truth). Null (unknown) is treated as moving on both sides, same
 * convention as the rest of this module. Returns null when lengths mismatch
 * or the arrays are empty.
 */
export function compareMovingFlags(
  derived: Array<boolean | null>,
  real: Array<boolean | null>,
): MovingFlagComparison | null {
  const n = derived.length;
  if (n === 0 || real.length !== n) return null;

  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < n; i++) {
    const d = derived[i] !== false;
    const r = real[i] !== false;
    if (d && r) tp++;
    else if (!d && !r) tn++;
    else if (!d && r) fp++;
    else fn++;
  }
  return { totalSamples: n, agreeingSamples: tp + tn, truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn };
}

export interface ConfirmedStopComparison {
  /** Confirmed stops in the real (Strava) flag. */
  realStops: number;
  /** Confirmed stops in the derived flag. */
  derivedStops: number;
  /** Real stops with an overlapping derived stop — recall = matchedReal / realStops. */
  matchedReal: number;
  /** Derived stops with an overlapping real stop — precision = matchedDerived / derivedStops. */
  matchedDerived: number;
}

/** Whether two [start, end) sample-index ranges overlap. */
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Compares two moving flags at the level that actually matters for net-time
 * correction: confirmed (>= minStopS) stops, not raw samples. A real stop
 * counts as detected if ANY derived stop overlaps its index range, and vice
 * versa — this is deliberately lenient on exact boundaries (a stop found a
 * couple of samples early/late still means the correction would have fired),
 * while still penalizing a real stop missed entirely or a derived stop that
 * doesn't correspond to anything Strava flagged.
 */
export function compareConfirmedStops(
  timeS: number[],
  derived: Array<boolean | null>,
  real: Array<boolean | null>,
  minStopS: number = MIN_STOP_S,
): ConfirmedStopComparison {
  const realStops = findConfirmedStops(timeS, real, minStopS);
  const derivedStops = findConfirmedStops(timeS, derived, minStopS);

  const matchedReal = realStops.filter((r) =>
    derivedStops.some((d) => rangesOverlap(r.stopStart, r.resumeIdx, d.stopStart, d.resumeIdx)),
  ).length;
  const matchedDerived = derivedStops.filter((d) =>
    realStops.some((r) => rangesOverlap(d.stopStart, d.resumeIdx, r.stopStart, r.resumeIdx)),
  ).length;

  return {
    realStops: realStops.length,
    derivedStops: derivedStops.length,
    matchedReal,
    matchedDerived,
  };
}

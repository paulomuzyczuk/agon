// Round-trip distance calibration.
//
// ORS `round_trip` treats its `length` as a hint to a loop-search heuristic, not
// a constraint: the loop it returns can miss the requested length badly wherever
// the walkable graph is sparse or hemmed in. On Berlin's dense grid the miss is
// small; on an island's coastal geometry a 7.5 km request came back as 9.4, 17.5 and
// 22.8 km loops — unusable as "run 7.5 km today" suggestions.
//
// The fix is a second pass: measure how far off the first attempt landed, scale
// the requested length by that ratio, and ask again. The engine's output length
// is monotonic enough in the requested length that one correction lands most
// seeds inside the tolerance. Pure + unit-tested; the network calls live in
// generate.ts.

/** Fractional distance error we accept without re-asking (10%). */
export const DEFAULT_TOLERANCE = 0.1;

// Guard-rails on the corrected request. A wildly off first attempt (a seed that
// returned a 40 km loop for a 7.5 km ask) would otherwise produce an absurd
// correction that wastes the retry.
const MIN_SCALE = 0.25;
const MAX_SCALE = 2.5;

/** Fractional error of an actual distance against the target. */
export function relativeError(actualKm: number, targetKm: number): number {
  if (!(targetKm > 0)) return Infinity;
  return Math.abs(actualKm - targetKm) / targetKm;
}

/** True when a candidate is far enough off target to be worth re-requesting. */
export function needsCalibration(
  actualKm: number,
  targetKm: number,
  tolerance: number = DEFAULT_TOLERANCE,
): boolean {
  return relativeError(actualKm, targetKm) > tolerance;
}

/**
 * The length to request on the retry, given what we asked for last time and what
 * the engine actually returned. Scales the request by target/actual — if asking
 * for 7.5 km yielded 9.4 km, ask for 7.5 × (7.5/9.4) ≈ 6.0 km next time.
 *
 * Returns null when no useful correction exists (non-positive inputs), so the
 * caller keeps the original candidate rather than firing a pointless request.
 */
export function calibratedRequestKm(
  requestedKm: number,
  actualKm: number,
  targetKm: number,
): number | null {
  if (!(requestedKm > 0) || !(actualKm > 0) || !(targetKm > 0)) return null;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetKm / actualKm));
  const next = requestedKm * scale;
  // A correction that rounds back to the same request buys nothing.
  if (Math.abs(next - requestedKm) < 0.05) return null;
  return next;
}

/** Pick whichever of two attempts landed closer to the target. */
export function closerToTarget<T extends { distanceM: number }>(
  a: T,
  b: T,
  targetKm: number,
): T {
  const targetM = targetKm * 1000;
  return Math.abs(a.distanceM - targetM) <= Math.abs(b.distanceM - targetM)
    ? a
    : b;
}

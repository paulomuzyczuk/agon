// Pure resampling math for Fitbit-wrist-derived cadence — an independent
// SECOND opinion on run-stop detection alongside the existing GPS-speed
// (lib/movingTime.ts::deriveMovingFlags) and phone-cadence
// (deriveMovingFlagsFromCadence) methods. See docs/methodology-log.md
// (2026-09-05, "Fitbit-wrist cadence") for the full investigation.
//
// Google Health's `steps` dataType (services/googleHealth/steps.ts fetches it)
// is native to 1-MINUTE buckets for the Fitbit Air's own wrist recording —
// far coarser than the per-sample (often ~1 Hz) time axis of the
// distance-bearing run_streams row this gets attached to. This module turns a
// list of {start, end, steps} buckets into a per-sample cadence value aligned
// to an arbitrary target time axis, by broadcasting each bucket's rate
// (steps/min) across every target sample that falls inside it. No I/O, no
// Google-Health-specific typing — services/googleHealth/steps.ts owns parsing
// the raw API shape into StepsBucket.

export interface StepsBucket {
  /** Bucket start, epoch ms. */
  startMs: number;
  /** Bucket end, epoch ms (exclusive). */
  endMs: number;
  /** Total steps (both feet) recorded in [startMs, endMs). */
  steps: number;
}

/**
 * Steps/min rate for one bucket. Null for a zero-or-negative-duration bucket
 * (can't derive a rate).
 */
function bucketRateSpm(b: StepsBucket): number | null {
  const durationMin = (b.endMs - b.startMs) / 60_000;
  return durationMin > 0 ? b.steps / durationMin : null;
}

export interface ResampledCadence {
  /** Same length as the input timeS — steps/min (both-feet total), or null where no bucket covers that instant. */
  cadence: Array<number | null>;
  /** Count of samples that landed inside a bucket. */
  coveredSamples: number;
}

/**
 * Resamples sorted, non-overlapping StepsBuckets onto a target (timeS,
 * runStartMs) axis: for each target instant, looks up the bucket containing
 * it and broadcasts that bucket's steps/min rate. Buckets are assumed sorted
 * ascending by startMs (services/googleHealth/steps.ts sorts them) and
 * non-overlapping (true for one device's own minute-aligned recording); a
 * target instant with no covering bucket (device off-wrist, sync gap) gets
 * null — never inferred/interpolated, since a gap here means "not measured,"
 * not "zero cadence." timeS must be sorted ascending (the run_streams
 * convention). Returns an all-null result for empty buckets.
 */
export function resampleCadence(
  buckets: StepsBucket[],
  timeS: number[],
  runStartMs: number,
): ResampledCadence {
  const cadence = new Array<number | null>(timeS.length).fill(null);
  if (buckets.length === 0) return { cadence, coveredSamples: 0 };

  let coveredSamples = 0;
  let bucketIdx = 0;
  for (let i = 0; i < timeS.length; i++) {
    const absMs = runStartMs + timeS[i]! * 1000;
    while (bucketIdx < buckets.length - 1 && absMs >= buckets[bucketIdx]!.endMs) {
      bucketIdx++;
    }
    const b = buckets[bucketIdx]!;
    if (absMs >= b.startMs && absMs < b.endMs) {
      const rate = bucketRateSpm(b);
      if (rate != null) {
        cadence[i] = Math.round(rate);
        coveredSamples++;
      }
    }
  }
  return { cadence, coveredSamples };
}

/**
 * Fraction of the run's EXPECTED 1-minute buckets (ceil(durationS / 60)) that
 * the wrist device actually has a bucket for — the per-run "was the band
 * actually recording steps during this run" signal, independent of how many
 * target samples happen to fall inside covered buckets (which skews with
 * sample density). Used to gate which runs are trustworthy enough to include
 * in a moving-flag comparison at all — see scripts/backfill-fitbit-cadence.ts.
 */
export function bucketCoverageFraction(buckets: StepsBucket[], durationS: number): number {
  if (durationS <= 0) return 0;
  const expectedBuckets = Math.max(1, Math.ceil(durationS / 60));
  return Math.min(1, buckets.length / expectedBuckets);
}

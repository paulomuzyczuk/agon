import {
  computeMovingTime,
  estimateNetTime,
  buildNetAdjustedStream,
  deriveMovingFlags,
  deriveMovingFlagsFromCadence,
  compareMovingFlags,
  compareConfirmedStops,
} from '@/lib/movingTime';
import { findBestEffort } from '@/lib/bestEfforts';

/** Build a constant-pace segment of samples every stepS seconds. */
function segment(
  startT: number,
  startD: number,
  speedMps: number,
  stepS: number,
  count: number,
  movingFlag: boolean,
): { t: number[]; d: number[]; m: boolean[] } {
  const t: number[] = [];
  const d: number[] = [];
  const m: boolean[] = [];
  for (let i = 1; i <= count; i++) {
    t.push(startT + i * stepS);
    d.push(startD + (movingFlag ? i * stepS * speedMps : 0));
    m.push(movingFlag);
  }
  return { t, d, m };
}

function concat(...parts: { t: number[]; d: number[]; m: boolean[] }[]) {
  return {
    timeS: [0, ...parts.flatMap((p) => p.t)],
    distanceM: [0, ...parts.flatMap((p) => p.d)],
    moving: [true, ...parts.flatMap((p) => p.m)],
  };
}

describe('computeMovingTime', () => {
  it('counts everything as moving when no stops are flagged', () => {
    const timeS = [0, 10, 20, 30];
    const moving = [true, true, true, true];
    expect(computeMovingTime(timeS, moving)).toEqual({ movingTimeS: 30, pausedTimeS: 0 });
  });

  it('excludes intervals ending on a flagged stop', () => {
    // Stopped for the 10->20 and 20->30 intervals (a 20s red light).
    const timeS = [0, 10, 20, 30, 40];
    const moving = [true, true, false, false, true];
    const result = computeMovingTime(timeS, moving);
    expect(result).toEqual({ movingTimeS: 20, pausedTimeS: 20 });
  });

  it('treats null/undefined as moving (never manufactures a stop)', () => {
    const timeS = [0, 10, 20];
    const moving = [true, null, undefined as unknown as boolean | null];
    expect(computeMovingTime(timeS, moving)).toEqual({ movingTimeS: 20, pausedTimeS: 0 });
  });

  it('skips non-increasing time deltas without going negative', () => {
    const timeS = [0, 10, 10, 20];
    const moving = [true, true, true, true];
    const result = computeMovingTime(timeS, moving);
    expect(result).not.toBeNull();
    expect(result!.movingTimeS).toBe(20);
    expect(result!.pausedTimeS).toBe(0);
  });

  it('returns null for too-short or mismatched-length input', () => {
    expect(computeMovingTime([0], [true])).toBeNull();
    expect(computeMovingTime([0, 10], [true])).toBeNull();
  });

  it('does not treat scattered single-sample flicker noise as real stops', () => {
    // Live data check (2026-09-05): one continuous 62-minute run flickered
    // moving=false for a single 1 Hz sample ~780 times (GPS/algorithm noise),
    // only 6 of which were real (>=5s) stops. A single-sample flicker every
    // 10s should cost nothing, not accumulate into a bogus multi-minute
    // discount (a naive version of this summed ~872s of "stops" from noise
    // that was really only ~93s of genuine stopped time).
    const n = 500;
    const timeS = Array.from({ length: n }, (_, i) => i); // 1 Hz for 499s
    const moving = Array.from({ length: n }, (_, i) => i % 10 !== 0); // flicker every 10th sample
    const result = computeMovingTime(timeS, moving)!;
    expect(result.pausedTimeS).toBe(0);
    expect(result.movingTimeS).toBe(n - 1);
  });

  it('excludes a recording gap that lands on a lone stopped sample (MZY-217)', () => {
    // Live shape (2026-07-26 run): 1 Hz running, then an 1898 s gap ending on
    // a single moving=false sample, then running again. The flagged span
    // alone (first stopped -> first moving sample) is 1 s, below minStopS —
    // but the interval leading INTO that sample is the pause itself.
    const timeS = [0, 1, 2, 3, 1901, 1902, 1903, 1904];
    const moving = [true, true, true, true, false, true, true, true];
    expect(computeMovingTime(timeS, moving)).toEqual({ movingTimeS: 6, pausedTimeS: 1898 });
  });

  it('still counts a gap landing on a moving sample as moving', () => {
    // Strava keeps some gaps as moving (live 2026-06-18: 1243 s, 2.6 km,
    // flagged moving) — the gap alone never manufactures a stop.
    const timeS = [0, 1, 2, 1245, 1246];
    const moving = [true, true, true, true, true];
    expect(computeMovingTime(timeS, moving)).toEqual({ movingTimeS: 1246, pausedTimeS: 0 });
  });

  it('keeps a lone stopped sample after an ordinary 2 s interval as flicker', () => {
    // 2 s is normal Strava sampling (~5% of intervals) — not a gap.
    const timeS = [0, 2, 4, 6, 8, 10];
    const moving = [true, true, true, false, true, true];
    expect(computeMovingTime(timeS, moving)).toEqual({ movingTimeS: 10, pausedTimeS: 0 });
  });
});

describe('estimateNetTime', () => {
  it('matches plain moving time when there are no stops', () => {
    const { timeS, distanceM, moving } = concat(segment(0, 0, 4, 10, 10, true));
    const result = estimateNetTime(timeS, distanceM, moving);
    expect(result).toEqual({ netTimeS: 100, recoveryBonusS: 0, stopsCounted: 0 });
  });

  it('charges no bonus when the post-stop pace matches the baseline', () => {
    const { timeS, distanceM, moving } = concat(
      segment(0, 0, 4, 10, 5, true), // baseline: 4 m/s for 50s
      segment(50, 200, 0, 10, 2, false), // 20s forced stop
      segment(70, 200, 4, 10, 5, true), // resumes at the SAME 4 m/s
    );
    const result = estimateNetTime(timeS, distanceM, moving);
    expect(result).toEqual({ netTimeS: 100, recoveryBonusS: 0, stopsCounted: 1 });
    // sanity: equals plain moving time (no boost detected -> no adjustment)
    expect(result!.netTimeS).toBe(computeMovingTime(timeS, moving)!.movingTimeS);
  });

  it('charges back time when the post-stop pace is a genuine boost', () => {
    const { timeS, distanceM, moving } = concat(
      segment(0, 0, 4, 10, 5, true), // baseline: 4 m/s for 50s
      segment(50, 200, 0, 10, 2, false), // 20s forced stop
      segment(70, 200, 8, 10, 5, true), // resumes at DOUBLE speed (8 m/s)
    );
    const result = estimateNetTime(timeS, distanceM, moving);
    const movingTimeS = computeMovingTime(timeS, moving)!.movingTimeS;
    expect(result!.stopsCounted).toBe(1);
    expect(result!.recoveryBonusS).toBeGreaterThan(0);
    expect(result!.netTimeS).toBe(movingTimeS + result!.recoveryBonusS);
    expect(result!.netTimeS).toBeGreaterThan(movingTimeS); // net pace is slower than naive moving pace
    expect(result).toEqual({ netTimeS: 150, recoveryBonusS: 50, stopsCounted: 1 });
  });

  it('ignores a stop shorter than minStopS as GPS/algorithm noise', () => {
    const { timeS, distanceM, moving } = concat(
      segment(0, 0, 4, 10, 5, true), // baseline: 4 m/s for 50s
      segment(50, 200, 0, 2, 1, false), // a 2s blip, not a real stop
      segment(52, 200, 8, 2, 5, true), // "recovery" at 8 m/s right after
    );
    const result = estimateNetTime(timeS, distanceM, moving);
    expect(result!.stopsCounted).toBe(0);
    expect(result!.recoveryBonusS).toBe(0);
    expect(result!.netTimeS).toBe(computeMovingTime(timeS, moving)!.movingTimeS);
  });

  it('does not count a trailing stop the run never resumes from', () => {
    const { timeS, distanceM, moving } = concat(
      segment(0, 0, 4, 10, 5, true),
      segment(50, 200, 0, 10, 3, false), // run ends mid-stop
    );
    const result = estimateNetTime(timeS, distanceM, moving);
    expect(result!.stopsCounted).toBe(0);
    expect(result!.netTimeS).toBe(computeMovingTime(timeS, moving)!.movingTimeS);
  });

  it('decides each stop independently — one boosted, one not, in the same run', () => {
    const { timeS, distanceM, moving } = concat(
      segment(0, 0, 4, 10, 5, true), // baseline: 4 m/s for 50s
      segment(50, 200, 0, 10, 2, false), // stop 1 (20s)
      segment(70, 200, 8, 10, 5, true), // boosted recovery: double speed
      segment(120, 600, 4, 10, 3, true), // back to baseline pace
      segment(150, 720, 0, 10, 2, false), // stop 2 (20s)
      segment(170, 720, 4, 10, 5, true), // recovery at the SAME baseline pace — no boost
    );
    const result = estimateNetTime(timeS, distanceM, moving);
    expect(result!.stopsCounted).toBe(2);
    expect(result!.recoveryBonusS).toBe(50); // only stop 1's window contributes
    expect(result!.netTimeS).toBe(
      computeMovingTime(timeS, moving)!.movingTimeS + result!.recoveryBonusS,
    );
  });

  it('returns null for too-short or mismatched-length input', () => {
    expect(estimateNetTime([0], [0], [true])).toBeNull();
    expect(estimateNetTime([0, 10], [0, 10, 20], [true, true])).toBeNull();
  });
});

describe('buildNetAdjustedStream', () => {
  it('leaves the stream identical to the input when there are no stops', () => {
    const { timeS, distanceM, moving } = concat(segment(0, 0, 4, 10, 10, true));
    const adjusted = buildNetAdjustedStream(timeS, distanceM, moving);
    expect(adjusted).not.toBeNull();
    expect(adjusted!.timeS).toEqual(timeS);
    expect(adjusted!.distanceM).toEqual(distanceM);
    expect(adjusted!.recoveryBonusS).toBe(0);
  });

  it('is monotonic non-decreasing and its total span matches estimateNetTime', () => {
    const { timeS, distanceM, moving } = concat(
      segment(0, 0, 4, 10, 5, true),
      segment(50, 200, 0, 10, 2, false),
      segment(70, 200, 8, 10, 5, true),
    );
    const adjusted = buildNetAdjustedStream(timeS, distanceM, moving)!;
    for (let i = 1; i < adjusted.timeS.length; i++) {
      expect(adjusted.timeS[i]).toBeGreaterThanOrEqual(adjusted.timeS[i - 1]!);
      expect(adjusted.distanceM[i]).toBeGreaterThanOrEqual(adjusted.distanceM[i - 1]!);
    }
    const span = adjusted.timeS[adjusted.timeS.length - 1]! - adjusted.timeS[0]!;
    expect(span).toBe(estimateNetTime(timeS, distanceM, moving)!.netTimeS);
  });

  it('never lets a search find a faster split than the real data supports (GPS drift during a stop)', () => {
    // A run with MANY brief forced stops, each with a sliver of GPS drift
    // (a few metres) while flagged stopped — exactly the shape that broke a
    // naive time-only version of this function (a live 1-second "1K").
    const parts: { t: number[]; d: number[]; m: boolean[] }[] = [];
    let t = 0;
    let d = 0;
    for (let stopNum = 0; stopNum < 20; stopNum++) {
      parts.push(segment(t, d, 4, 10, 3, true)); // 30s of real running
      t += 30;
      d += 30 * 4;
      // A 10s "stop" with 3m of GPS drift credited despite moving=false.
      parts.push({ t: [t + 10], d: [d + 3], m: [false] });
      t += 10;
      d += 3;
    }
    const { timeS, distanceM, moving } = concat(...parts);
    const adjusted = buildNetAdjustedStream(timeS, distanceM, moving)!;
    expect(adjusted).not.toBeNull();

    // 20 stops * 30s of real running each = 600s covers 20*120m = 2400m.
    // A 1K search must take at least as long as running it for real (250s at
    // 4 m/s) — nowhere near instantaneous.
    const oneK = findBestEffort(adjusted.timeS, adjusted.distanceM, 1000);
    expect(oneK).not.toBeNull();
    expect(oneK!.elapsedS).toBeGreaterThan(200);
  });

  it('freezes distance together with time across a paused recording gap', () => {
    // The 2026-07-26 shape: ~2 km of distance jumps across an 1898 s gap
    // that ends on a lone stopped sample. Freezing the time but crediting
    // the 2 km would hand a sliding-window search a near-instant 2K — the
    // gap's distance is dropped along with its time.
    const timeS = [0, 100, 200, 2098, 2198, 2298];
    const distanceM = [0, 400, 800, 2752, 3152, 3552];
    const moving = [true, true, true, false, true, true];
    const adjusted = buildNetAdjustedStream(timeS, distanceM, moving)!;
    expect(adjusted.stopsCounted).toBe(1);
    expect(adjusted.distanceM[3]).toBe(800);
    expect(adjusted.timeS[3]).toBe(200);
    // Every remaining metre still costs its real time (4 m/s).
    const oneK = findBestEffort(adjusted.timeS, adjusted.distanceM, 1000)!;
    expect(oneK.elapsedS).toBeCloseTo(250, 6);
  });

  it('returns null for too-short or mismatched-length input', () => {
    expect(buildNetAdjustedStream([0], [0], [true])).toBeNull();
    expect(buildNetAdjustedStream([0, 10], [0, 10, 20], [true, true])).toBeNull();
  });
});

describe('deriveMovingFlags', () => {
  it('flags a constant fast pace as moving throughout (first sample included)', () => {
    const { timeS, distanceM } = concat(segment(0, 0, 4, 10, 10, true)); // 4 m/s
    const flags = deriveMovingFlags(timeS, distanceM)!;
    expect(flags).not.toBeNull();
    expect(flags.every((f) => f === true)).toBe(true);
  });

  it('flags a real stop (near-zero speed) as stopped', () => {
    const { timeS, distanceM } = concat(
      segment(0, 0, 4, 10, 5, true),
      segment(50, 200, 0, 10, 3, false), // distance frozen -> speed 0
      segment(80, 200, 4, 10, 5, true),
    );
    const flags = deriveMovingFlags(timeS, distanceM)!;
    // Indices 6,7,8 correspond to the frozen-distance stretch.
    expect(flags[6]).toBe(false);
    expect(flags[7]).toBe(false);
    expect(flags[8]).toBe(false);
    expect(flags[1]).toBe(true);
    expect(flags[flags.length - 1]).toBe(true);
  });

  it('respects a custom speed threshold', () => {
    const { timeS, distanceM } = concat(segment(0, 0, 1, 10, 5, true)); // 1 m/s (a slow jog)
    expect(deriveMovingFlags(timeS, distanceM, { stopSpeedMps: 0.6 })!.every((f) => f)).toBe(true);
    expect(deriveMovingFlags(timeS, distanceM, { stopSpeedMps: 2 })!.slice(1).every((f) => !f)).toBe(true);
  });

  it('returns null for too-short or mismatched-length input', () => {
    expect(deriveMovingFlags([0], [0])).toBeNull();
    expect(deriveMovingFlags([0, 10], [0, 10, 20])).toBeNull();
  });

  // MZY-218: known limitation, pinned on purpose. A recording gap's only speed
  // is its average, so the post-gap sample is judged on it like any other
  // interval. Shaped on the live 2026-07-26 end-of-run gap (1898 s, 1952 m,
  // 1.03 m/s, walking at ~1.0 m/s on both edges): derived as moving even
  // though Strava's flag has it stopped — the stream carries no signal that
  // separates it from gaps Strava counts as moving (see methodology log).
  it('judges a post-gap sample on the gap average speed (known limitation)', () => {
    const timeS = [0, 1, 2, 3, 1901, 1902];
    const distanceM = [0, 1, 2, 3, 1955, 1956]; // 1952 m over 1898 s = 1.03 m/s
    expect(deriveMovingFlags(timeS, distanceM)).toEqual([true, true, true, true, true, true]);
    // Same gap covered at a stand-still pace is stopped, as for any interval.
    const standing = [0, 1, 2, 3, 3, 4];
    expect(deriveMovingFlags(timeS, standing)![4]).toBe(false);
  });
});

describe('deriveMovingFlagsFromCadence', () => {
  it('flags running cadence as moving', () => {
    const timeS = [0, 1, 2, 3, 4];
    const cadence = [78, 79, 78, 77, 78];
    expect(deriveMovingFlagsFromCadence(timeS, cadence)).toEqual([true, true, true, true, true]);
  });

  it('flags near-zero cadence as stopped', () => {
    const timeS = [0, 1, 2, 3, 4];
    const cadence = [78, 0, 0, 0, 79];
    expect(deriveMovingFlagsFromCadence(timeS, cadence)).toEqual([true, false, false, false, true]);
  });

  it('treats null cadence (sensor dropout) as moving', () => {
    const timeS = [0, 1, 2];
    const cadence = [78, null, 78];
    expect(deriveMovingFlagsFromCadence(timeS, cadence)).toEqual([true, true, true]);
  });

  it('respects a custom cadence threshold', () => {
    const timeS = [0, 1, 2];
    const cadence = [40, 40, 40];
    expect(deriveMovingFlagsFromCadence(timeS, cadence, { stopCadenceSpm: 15 })).toEqual([true, true, true]);
    expect(deriveMovingFlagsFromCadence(timeS, cadence, { stopCadenceSpm: 50 })).toEqual([false, false, false]);
  });

  it('returns null for too-short or mismatched-length input', () => {
    expect(deriveMovingFlagsFromCadence([0], [0])).toBeNull();
    expect(deriveMovingFlagsFromCadence([0, 1], [0, 1, 2])).toBeNull();
  });
});

describe('compareMovingFlags', () => {
  it('reports full agreement when both flags match exactly', () => {
    const real = [true, true, false, false, true];
    const derived = [true, true, false, false, true];
    expect(compareMovingFlags(derived, real)).toEqual({
      totalSamples: 5,
      agreeingSamples: 5,
      truePositive: 3,
      trueNegative: 2,
      falsePositive: 0,
      falseNegative: 0,
    });
  });

  it('counts false positives and negatives on disagreement', () => {
    const real =    [true, true, false, true,  false];
    const derived = [true, false, false, true, true];
    // idx1: derived stopped, real moving -> FP. idx4: derived moving, real stopped -> FN.
    expect(compareMovingFlags(derived, real)).toEqual({
      totalSamples: 5,
      agreeingSamples: 3,
      truePositive: 2,
      trueNegative: 1,
      falsePositive: 1,
      falseNegative: 1,
    });
  });

  it('returns null for mismatched lengths or empty input', () => {
    expect(compareMovingFlags([true], [true, false])).toBeNull();
    expect(compareMovingFlags([], [])).toBeNull();
  });
});

describe('compareConfirmedStops', () => {
  it('matches a derived stop that overlaps a real one, even with different exact bounds', () => {
    const timeS = Array.from({ length: 30 }, (_, i) => i * 5); // 0,5,10,...,145
    const real = timeS.map((_, i) => !(i >= 10 && i <= 14)); // stop idx10-14 (25s)
    const derived = timeS.map((_, i) => !(i >= 11 && i <= 13)); // overlapping, narrower stop
    const cmp = compareConfirmedStops(timeS, derived, real);
    expect(cmp).toEqual({ realStops: 1, derivedStops: 1, matchedReal: 1, matchedDerived: 1 });
  });

  it('counts a missed real stop and an unmatched derived stop separately', () => {
    const timeS = Array.from({ length: 40 }, (_, i) => i * 5);
    const real = timeS.map((_, i) => !(i >= 10 && i <= 14)); // real stop A
    const derived = timeS.map((_, i) => !(i >= 25 && i <= 29)); // unrelated derived stop B
    const cmp = compareConfirmedStops(timeS, derived, real);
    expect(cmp).toEqual({ realStops: 1, derivedStops: 1, matchedReal: 0, matchedDerived: 0 });
  });
});

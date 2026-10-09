import {
  hrReserveFraction,
  trimpWeight,
  relativeEffortFromStream,
  relativeEffortFromAverage,
  fitPaceHrModel,
  estimateHrFromPace,
  relativeEffortFromPace,
  PACE_HR_MIN_PAIRS,
  type PaceHrPair,
} from '@/lib/relativeEffort';

// Pure Banister TRIMP math — no DB, no network. Anchors mirror the athlete
// profile (HR_rest 67, HR_max 194 → reserve span 127 bpm).
const ANCHORS = { hrRest: 60, hrMax: 190 };

describe('hrReserveFraction', () => {
  it('maps HR onto 0..1 across the reserve', () => {
    expect(hrReserveFraction(60, ANCHORS)).toBe(0); // at rest
    expect(hrReserveFraction(190, ANCHORS)).toBe(1); // at max
    expect(hrReserveFraction(125, ANCHORS)).toBeCloseTo(0.5, 5); // midpoint
  });
  it('clamps out-of-range HR', () => {
    expect(hrReserveFraction(50, ANCHORS)).toBe(0); // below rest
    expect(hrReserveFraction(210, ANCHORS)).toBe(1); // above max
  });
  it('guards against inverted anchors', () => {
    expect(hrReserveFraction(150, { hrRest: 200, hrMax: 100 })).toBe(0);
  });
});

describe('trimpWeight', () => {
  it('is zero at rest and monotonic increasing with intensity', () => {
    expect(trimpWeight(0)).toBe(0);
    expect(trimpWeight(0.3)).toBeLessThan(trimpWeight(0.6));
    expect(trimpWeight(0.6)).toBeLessThan(trimpWeight(0.9));
  });
  it('matches the Banister formula at max (y=1): 0.64·e^1.92', () => {
    expect(trimpWeight(1)).toBeCloseTo(0.64 * Math.exp(1.92), 6);
  });
});

describe('relativeEffortFromStream', () => {
  it('integrates a steady effort ≈ the average-HR form', () => {
    // 600 s at a constant 130 bpm, sampled every 10 s.
    const timeS: number[] = [];
    const hr: number[] = [];
    for (let t = 0; t <= 600; t += 10) {
      timeS.push(t);
      hr.push(130);
    }
    const stream = relativeEffortFromStream(timeS, hr, ANCHORS);
    const avg = relativeEffortFromAverage(600, 130, ANCHORS);
    expect(stream).not.toBeNull();
    expect(stream!).toBeCloseTo(avg!, 1);
  });

  it('scores a harder OR longer session higher (the core property)', () => {
    const steady = (dur: number, bpm: number): number => {
      const t: number[] = [];
      const h: number[] = [];
      for (let s = 0; s <= dur; s += 10) {
        t.push(s);
        h.push(bpm);
      }
      return relativeEffortFromStream(t, h, ANCHORS)!;
    };
    expect(steady(600, 170)).toBeGreaterThan(steady(600, 120)); // harder
    expect(steady(1800, 140)).toBeGreaterThan(steady(600, 140)); // longer
  });

  it('interpolates across a null dropout using the present endpoint', () => {
    const out = relativeEffortFromStream(
      [0, 10, 20],
      [150, null, 150],
      ANCHORS,
    );
    expect(out).not.toBeNull();
    expect(out!).toBeGreaterThan(0);
  });

  it('clamps a long pause gap so it does not inflate the score', () => {
    const paused = relativeEffortFromStream([0, 3600], [160, 160], {
      ...ANCHORS,
      maxSampleGapS: 30,
    });
    const capped = relativeEffortFromAverage(30, 160, ANCHORS); // only 30 s counts
    expect(paused).toBeCloseTo(capped!, 1);
  });

  it('returns null with fewer than two usable samples', () => {
    expect(relativeEffortFromStream([0], [150], ANCHORS)).toBeNull();
    expect(relativeEffortFromStream([0, 10], [null, null], ANCHORS)).toBeNull();
  });
});

describe('relativeEffortFromAverage', () => {
  it('returns null for non-positive duration', () => {
    expect(relativeEffortFromAverage(0, 150, ANCHORS)).toBeNull();
  });
  it('scales with duration', () => {
    const a = relativeEffortFromAverage(600, 150, ANCHORS)!;
    const b = relativeEffortFromAverage(1200, 150, ANCHORS)!;
    expect(b).toBeCloseTo(a * 2, 0); // exactly 2× up to 1-dp rounding
  });
});

// A clean synthetic model: HR rises exactly 20 bpm per m/s from a 100-bpm
// intercept (so at 2.5 m/s → 150 bpm), used to check the surrogate end-to-end.
function linearPairs(): PaceHrPair[] {
  const pairs: PaceHrPair[] = [];
  for (let i = 0; i < 12; i++) {
    const speedMps = 2.0 + i * 0.1; // 2.0 … 3.1 m/s
    pairs.push({ speedMps, hr: 100 + 20 * speedMps });
  }
  return pairs;
}

describe('fitPaceHrModel', () => {
  it('recovers the slope and intercept of a linear relationship', () => {
    const model = fitPaceHrModel(linearPairs());
    expect(model).not.toBeNull();
    expect(model!.b).toBeCloseTo(20, 6);
    expect(model!.a).toBeCloseTo(100, 6);
    expect(model!.r2).toBeCloseTo(1, 6); // perfectly linear
  });

  it('returns null below the minimum pair count', () => {
    const few = linearPairs().slice(0, PACE_HR_MIN_PAIRS - 1);
    expect(fitPaceHrModel(few)).toBeNull();
  });

  it('returns null when pace has no variance (cannot fit a slope)', () => {
    const flat: PaceHrPair[] = Array.from({ length: 10 }, () => ({
      speedMps: 2.5,
      hr: 150,
    }));
    expect(fitPaceHrModel(flat)).toBeNull();
  });

  it('ignores non-finite / non-positive-speed pairs', () => {
    const dirty = [
      ...linearPairs(),
      { speedMps: 0, hr: 150 },
      { speedMps: NaN, hr: 150 },
    ];
    const model = fitPaceHrModel(dirty);
    expect(model!.n).toBe(12); // only the clean pairs counted
    expect(model!.b).toBeCloseTo(20, 6);
  });
});

describe('estimateHrFromPace', () => {
  const model = fitPaceHrModel(linearPairs())!;
  it('applies the linear fit at a given speed', () => {
    expect(estimateHrFromPace(2.5, model, ANCHORS)).toBeCloseTo(150, 6); // 100 + 20·2.5
  });
  it('clamps below rest and above max for out-of-domain paces', () => {
    // A low-intercept model dips under rest at a crawl → clamps up to hrRest.
    const lowModel = { a: 55, b: 1, n: 10, r2: 0.5 };
    expect(estimateHrFromPace(1, lowModel, ANCHORS)).toBe(ANCHORS.hrRest); // 56 → 60
    expect(estimateHrFromPace(10, model, ANCHORS)).toBe(ANCHORS.hrMax); // 300 → 190
  });
});

describe('relativeEffortFromPace', () => {
  const model = fitPaceHrModel(linearPairs())!;
  it('matches the average-HR score for the pace-estimated HR', () => {
    // 5 km in 2000 s → 2.5 m/s → est HR 150. Score must equal the avg-HR form at 150.
    const pe = relativeEffortFromPace(2000, 5, model, ANCHORS);
    expect(pe).not.toBeNull();
    expect(pe!.estimatedHr).toBe(150);
    expect(pe!.score).toBeCloseTo(
      relativeEffortFromAverage(2000, 150, ANCHORS)!,
      5,
    );
  });
  it('scores a faster run of equal duration higher', () => {
    const slow = relativeEffortFromPace(2000, 4, model, ANCHORS)!; // 2.0 m/s
    const fast = relativeEffortFromPace(2000, 6, model, ANCHORS)!; // 3.0 m/s
    expect(fast.score).toBeGreaterThan(slow.score);
  });
  it('returns null for non-positive duration or distance', () => {
    expect(relativeEffortFromPace(0, 5, model, ANCHORS)).toBeNull();
    expect(relativeEffortFromPace(2000, 0, model, ANCHORS)).toBeNull();
  });
});

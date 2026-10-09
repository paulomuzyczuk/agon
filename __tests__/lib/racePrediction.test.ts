import {
  fitRiegel,
  riegelFromFit,
  riegelFromAnchor,
  vdotFromPerformance,
  timeForVdot,
  pctVo2maxForDuration,
  referenceVdot,
  bandFraction,
  predictRaces,
  GENERIC_RIEGEL_K,
  type EffortPair,
} from '@/lib/racePrediction';

// Pure Riegel + Daniels VDOT math — no DB, no network.

describe('fitRiegel', () => {
  it('recovers a known exponent from synthetic pairs (T = a·D^k)', () => {
    const a = 0.9;
    const k = 1.1;
    const pairs: EffortPair[] = [1000, 3000, 5000, 10000, 21097].map((d) => ({
      distanceM: d,
      timeS: a * Math.pow(d, k),
    }));
    const fit = fitRiegel(pairs)!;
    expect(fit.fallback).toBe(false);
    expect(fit.k).toBeCloseTo(k, 4);
    expect(fit.a).toBeCloseTo(a, 4);
    expect(fit.r2).toBeCloseTo(1, 6);
  });

  it('predicts back the inputs it was fit on', () => {
    const pairs: EffortPair[] = [1000, 5000, 10000].map((d) => ({
      distanceM: d,
      timeS: 0.9 * Math.pow(d, 1.1),
    }));
    const fit = fitRiegel(pairs)!;
    expect(riegelFromFit(fit, 5000)).toBeCloseTo(0.9 * Math.pow(5000, 1.1), 2);
  });

  it('falls back to the generic exponent with too few pairs', () => {
    const fit = fitRiegel([{ distanceM: 5000, timeS: 1444 }])!;
    expect(fit.fallback).toBe(true);
    expect(fit.k).toBe(GENERIC_RIEGEL_K);
    // a chosen so it reproduces the single effort exactly.
    expect(riegelFromFit(fit, 5000)).toBeCloseTo(1444, 3);
  });

  it('returns null with no usable pairs', () => {
    expect(fitRiegel([])).toBeNull();
    expect(fitRiegel([{ distanceM: 0, timeS: 10 }])).toBeNull();
  });
});

describe('riegelFromAnchor', () => {
  it('projects with the classic power law', () => {
    // 5K in 20:00 → 10K with k=1.06.
    const t = riegelFromAnchor({ distanceM: 5000, timeS: 1200 }, 10000, 1.06);
    expect(t).toBeCloseTo(1200 * Math.pow(2, 1.06), 2);
  });
});

describe('Daniels VDOT', () => {
  it('pctVO2max decreases with duration and is ~1 near ~10-11 min', () => {
    expect(pctVo2maxForDuration(60)).toBeLessThan(pctVo2maxForDuration(10));
    expect(pctVo2maxForDuration(10)).toBeCloseTo(1, 1); // ~VO2max effort
  });

  it('matches a known Daniels table point (5K in 19:57 ≈ VDOT 50)', () => {
    expect(vdotFromPerformance(5000, 1197)).toBeCloseTo(50, 0);
  });

  it('is monotonically decreasing in time for a fixed distance', () => {
    expect(vdotFromPerformance(5000, 1300)).toBeLessThan(vdotFromPerformance(5000, 1200));
  });

  it('inverts: timeForVdot is the inverse of vdotFromPerformance', () => {
    const t = timeForVdot(5000, 50)!;
    expect(t).toBeCloseTo(1197, -1); // within ~10 s of the table value
    expect(vdotFromPerformance(5000, t)).toBeCloseTo(50, 3);
  });

  it('returns a finite positive time for a realistic VDOT', () => {
    const t = timeForVdot(10000, 40)!;
    expect(t).toBeGreaterThan(0);
    expect(vdotFromPerformance(10000, t)).toBeCloseTo(40, 3);
  });
});

describe('referenceVdot', () => {
  it('picks the highest VDOT within the valid duration window', () => {
    const pairs: EffortPair[] = [
      { distanceM: 400, timeS: 76 }, // too short — excluded
      { distanceM: 5000, timeS: 1444 }, // ~VDOT 40
      { distanceM: 10000, timeS: 3507 }, // lower VDOT
    ];
    const ref = referenceVdot(pairs)!;
    expect(ref.from.distanceM).toBe(5000);
    expect(ref.vdot).toBeCloseTo(vdotFromPerformance(5000, 1444), 6);
  });

  it('returns null when nothing falls in the window', () => {
    expect(referenceVdot([{ distanceM: 400, timeS: 76 }])).toBeNull();
  });
});

describe('bandFraction', () => {
  it('is the small base within the data range', () => {
    expect(bandFraction(10000, 21097)).toBeCloseTo(0.03, 6);
  });
  it('widens for extrapolation beyond the longest effort', () => {
    const half = bandFraction(21097, 21097);
    const marathon = bandFraction(42195, 21097);
    const ultra = bandFraction(70000, 21097);
    expect(marathon).toBeGreaterThan(half);
    expect(ultra).toBeGreaterThan(marathon);
  });
});

describe('predictRaces', () => {
  // The athlete's real best efforts (docs/strava-benchmark.md).
  const pairs: EffortPair[] = [
    { distanceM: 400, timeS: 76 },
    { distanceM: 1000, timeS: 257 },
    { distanceM: 1609, timeS: 447 },
    { distanceM: 5000, timeS: 1444 },
    { distanceM: 10000, timeS: 3507 },
    { distanceM: 21097, timeS: 8224 },
  ];

  it('produces a prediction per target, ordered fast→slow in time', () => {
    const { predictions } = predictRaces(pairs);
    expect(predictions.map((p) => p.label)).toEqual([
      '1K', '5K', '10K', 'Half-Marathon', 'Marathon', '70K',
    ]);
    const times = predictions.map((p) => p.predictedS);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });

  it('flags targets beyond the longest effort as extrapolated with wider bands', () => {
    const { predictions } = predictRaces(pairs);
    const half = predictions.find((p) => p.label === 'Half-Marathon')!;
    const ultra = predictions.find((p) => p.label === '70K')!;
    expect(half.extrapolated).toBe(false);
    expect(ultra.extrapolated).toBe(true);
    expect(ultra.bandPct).toBeGreaterThan(half.bandPct);
  });

  it('fits a personalized exponent above the generic 1.06 for this athlete', () => {
    const { fit } = predictRaces(pairs);
    expect(fit!.fallback).toBe(false);
    expect(fit!.k).toBeGreaterThan(GENERIC_RIEGEL_K); // fades harder than average
  });

  it('reports a reference VDOT and both cross-check columns', () => {
    const { vdotRef, predictions } = predictRaces(pairs);
    expect(vdotRef).not.toBeNull();
    const tenK = predictions.find((p) => p.label === '10K')!;
    expect(tenK.riegelGenericS).not.toBeNull();
    expect(tenK.vdotS).not.toBeNull();
  });
});

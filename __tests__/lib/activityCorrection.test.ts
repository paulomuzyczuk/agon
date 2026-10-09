import {
  avgPaceSPerKm,
  avgSpeedKmh,
  CorrectionError,
  extrapolateMissedStart,
  firstKmPace,
  keepCountAt,
  planCorrection,
  tailTrim,
  type CorrectionStream,
} from '@/lib/activityCorrection';

/**
 * A 1 Hz stream built from segments: `secs` seconds covering `metres`, with
 * every sample flagged `moving`.
 */
function stream(
  segments: Array<{ secs: number; metres: number; moving?: boolean }>,
  withFlags = true,
): CorrectionStream {
  const timeS = [0];
  const distanceM: number[] = [0];
  const moving: boolean[] = [true];
  for (const seg of segments) {
    const step = seg.metres / seg.secs;
    for (let i = 0; i < seg.secs; i++) {
      timeS.push(timeS[timeS.length - 1]! + 1);
      distanceM.push(distanceM[distanceM.length - 1]! + step);
      moving.push(seg.moving ?? true);
    }
  }
  return { timeS, distanceM, moving: withFlags ? moving : null };
}

describe('firstKmPace', () => {
  it('divides first-km moving seconds by the km covered at the crossing sample', () => {
    // 8 m/s with a 30 s stop inside the first km, excluded from moving time.
    const s = stream([
      { secs: 60, metres: 480 },
      { secs: 30, metres: 0, moving: false },
      { secs: 70, metres: 560 },
    ]);
    const p = firstKmPace(s)!;
    expect(p.basis).toBe('first_km_moving');
    // crossing at the first sample ≥ 1000 m: 480 + 8·k ≥ 1000 → k = 65 → 1000 m
    expect(p.paceSPerKm).toBeCloseTo(125, 5);
  });

  it('falls back to elapsed first-km pace on an unflagged stream', () => {
    const s = stream(
      [
        { secs: 60, metres: 480 },
        { secs: 30, metres: 0 },
        { secs: 70, metres: 560 },
      ],
      false,
    );
    expect(firstKmPace(s)).toEqual({
      paceSPerKm: 155,
      basis: 'first_km_elapsed',
    });
  });

  it('is null without distance or under 1 km', () => {
    expect(firstKmPace(null)).toBeNull();
    expect(
      firstKmPace({ timeS: [0, 1], distanceM: null, moving: null }),
    ).toBeNull();
    expect(firstKmPace(stream([{ secs: 100, metres: 900 }]))).toBeNull();
  });
});

describe('extrapolateMissedStart — the 2026-09-29 reference rides', () => {
  const totals = {
    distanceKm: 6.771,
    durationS: 1268,
    startedAt: '2026-09-29T16:54:33.000Z',
  };

  it('ride 1: +1.000 km at 163 s over 1002.6 m → +163 s', () => {
    // first sample past 1 km lands at 1002.6 m after 163 moving seconds
    const s: CorrectionStream = {
      timeS: [0, 100, 163],
      distanceM: [0, 600, 1002.6],
      moving: [true, true, true],
    };
    const x = extrapolateMissedStart(1, s, totals);
    expect(x.durationS).toBe(163);
    expect(x.basis).toBe('first_km_moving');
  });

  it('ride 2: +0.500 km at 149 s over 1003.3 m → +74 s', () => {
    // a 94 s stop inside the first km (140 → 234) is excluded: 90 + 50 + 9
    // = 149 moving seconds by the first sample past 1 km (1003.3 m)
    const s: CorrectionStream = {
      timeS: [0, 90, 140, 234, 243],
      distanceM: [0, 500, 700, 700, 1003.3],
      moving: [true, true, true, false, true],
    };
    const x = extrapolateMissedStart(0.5, s, totals);
    expect(x.paceSPerKm).toBeCloseTo(149 / 1.0033, 6);
    expect(x.durationS).toBe(74);
  });

  it('uses the activity average moving pace when there is no distance stream', () => {
    const x = extrapolateMissedStart(1, null, {
      distanceKm: 10,
      durationS: 3000,
      startedAt: null,
    });
    expect(x).toEqual({
      durationS: 300,
      paceSPerKm: 300,
      basis: 'activity_avg',
    });
  });

  it('rejects a non-positive distance or an activity with nothing to pace from', () => {
    expect(() => extrapolateMissedStart(0, null, totals)).toThrow(
      CorrectionError,
    );
    expect(() =>
      extrapolateMissedStart(1, null, {
        distanceKm: 0,
        durationS: 0,
        startedAt: null,
      }),
    ).toThrow(CorrectionError);
  });
});

describe('tailTrim', () => {
  it('cuts at max(time_s) − trim and sums the tail distance + moving seconds', () => {
    // 1737 s of riding, then a 180 s tail: 26 s flagged moving, 64 m covered
    const s = stream([
      { secs: 1737, metres: 7881 },
      { secs: 26, metres: 64 },
      { secs: 154, metres: 0, moving: false },
    ]);
    const t = tailTrim(s, 180);
    expect(t.cutAtS).toBe(1737);
    expect(t.keepCount).toBe(1738);
    expect(t.movingS).toBe(26);
    expect(t.distanceKm).toBeCloseTo(0.064, 6);
  });

  it('counts every tail second on an unflagged stream, and 0 km without distance', () => {
    const t = tailTrim(
      { timeS: [0, 60, 120, 180], distanceM: null, moving: null },
      60,
    );
    expect(t).toEqual({
      cutAtS: 120,
      keepCount: 3,
      distanceKm: 0,
      movingS: 60,
    });
  });

  it('refuses without a stream or when the cut would leave < 2 samples', () => {
    expect(() => tailTrim(null, 60)).toThrow(CorrectionError);
    expect(() =>
      tailTrim({ timeS: [0, 10], distanceM: null, moving: null }, 30),
    ).toThrow(CorrectionError);
  });
});

describe('keepCountAt', () => {
  it('keepCountAt counts samples at or before the cut', () => {
    expect(keepCountAt([0, 5, 10, 15], 10)).toBe(3);
    expect(keepCountAt([0, 5], -1)).toBe(0);
  });
});

describe('derived averages', () => {
  it('matches the reference rides after correction', () => {
    expect(avgSpeedKmh(7.771, 1431)).toBe(19.55);
    expect(avgSpeedKmh(8.381, 1559)).toBe(19.35);
    expect(avgPaceSPerKm(10, 3000)).toBe(300);
    expect(avgPaceSPerKm(0, 3000)).toBeNull();
    expect(avgSpeedKmh(5, 0)).toBeNull();
  });
});

describe('planCorrection', () => {
  const s = stream([
    { secs: 1000, metres: 7000 },
    { secs: 30, metres: 60 },
    { secs: 150, metres: 0, moving: false },
  ]);
  const before = {
    distanceKm: 7.06,
    durationS: 1030,
    startedAt: '2026-09-29T19:21:36.000Z',
  };

  it('missed start: adds distance + time and moves the start earlier', () => {
    const p = planCorrection(before, s, [{ kind: 'missed_start', addKm: 0.5 }]);
    // first km at 1000/7 m/s → 142.86 s/km → 0.5 km = 71 s
    expect(p.after.distanceKm).toBe(7.56);
    expect(p.after.durationS).toBe(1101);
    expect(p.after.startedAt).toBe('2026-09-29T19:20:25.000Z');
    expect(p.streamCutAtS).toBeNull();
    expect(p.steps[0]!.entry).toMatchObject({
      kind: 'missed_start',
      distance_km: 0.5,
      duration_s: 71,
      start_shift_s: 71,
    });
    expect(p.steps[0]!.note).toMatch(
      /\+0\.500 km \/ \+71 s.*start moved 71 s earlier/,
    );
  });

  it('late stop: removes the tail and reports the stream cut', () => {
    const p = planCorrection(before, s, [{ kind: 'late_stop', trimMin: 3 }]);
    expect(p.streamCutAtS).toBe(1000);
    expect(p.after.distanceKm).toBe(7);
    expect(p.after.durationS).toBe(1000);
    expect(p.after.startedAt).toBe(before.startedAt);
    expect(p.steps[0]!.entry).toMatchObject({
      kind: 'late_stop_trim',
      distance_km: -0.06,
      duration_s: -30,
      trimmed_elapsed_s: 180,
    });
  });

  it('applies both in order (the ride-2 shape) without mutating the input', () => {
    const p = planCorrection(before, s, [
      { kind: 'missed_start', addKm: 0.5 },
      { kind: 'late_stop', trimMin: 3 },
    ]);
    expect(p.after.distanceKm).toBe(7.5);
    expect(p.after.durationS).toBe(1071);
    expect(p.steps.map((x) => x.entry.kind)).toEqual([
      'missed_start',
      'late_stop_trim',
    ]);
    expect(before.distanceKm).toBe(7.06);
  });

  it('totals: free edit, logged as a delta', () => {
    const p = planCorrection(before, null, [
      { kind: 'totals', distanceKm: 7.1 },
    ]);
    expect(p.after).toEqual({ ...before, distanceKm: 7.1 });
    expect(p.steps[0]!.entry).toEqual({
      kind: 'totals',
      distance_km: 0.04,
      duration_s: 0,
    });
    expect(p.steps[0]!.note).toBe(
      'Manual correction: distance 7.060 → 7.100 km.',
    );
  });

  it('keeps a start-less activity start-less', () => {
    const p = planCorrection({ ...before, startedAt: null }, s, [
      { kind: 'missed_start', addKm: 1 },
    ]);
    expect(p.after.startedAt).toBeNull();
    expect(p.steps[0]!.entry).toMatchObject({ start_shift_s: 0 });
  });

  it('rejects empty, unchanged, double-trim and over-trim requests', () => {
    expect(() => planCorrection(before, s, [])).toThrow(CorrectionError);
    expect(() => planCorrection(before, s, [{ kind: 'totals' }])).toThrow(
      CorrectionError,
    );
    expect(() =>
      planCorrection(before, s, [
        { kind: 'late_stop', trimMin: 1 },
        { kind: 'late_stop', trimMin: 1 },
      ]),
    ).toThrow(CorrectionError);
    expect(() =>
      planCorrection(before, s, [{ kind: 'late_stop', trimMin: 25 }]),
    ).toThrow(CorrectionError);
  });
});

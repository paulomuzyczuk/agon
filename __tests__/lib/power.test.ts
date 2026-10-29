import {
  MAX_HOLD_GAP_S,
  POWER_CURVE_DURATIONS_S,
  computeRidePowerMetrics,
  intensityFactor,
  meanMaxCurve,
  normalizedPower,
  resampleTo1Hz,
  trainingStressScore,
} from '@/lib/power';

// Synthetic fixtures only: no power meter exists yet (MZY-269), so every
// series here is built by hand and every expected value is checked against
// an independent calculation (noted inline).

/** `seconds` of constant watts. */
const constant = (w: number, seconds: number): number[] =>
  Array.from({ length: seconds }, () => w);

/** Concatenate [watts, seconds] blocks. */
const blocks = (spec: Array<[number, number]>): number[] =>
  spec.flatMap(([w, s]) => constant(w, s));

/** A 1 Hz stream (timeS 0..n-1) for a series. */
const stream = (watts: Array<number | null>) => ({
  timeS: watts.map((_, i) => i),
  watts,
});

// 60 s @ 400 W / 60 s @ 100 W, × 30 = 1 h, average 250 W.
const INTERVALS = blocks(
  Array.from({ length: 30 }, () => [
    [400, 60],
    [100, 60],
  ]).flat() as Array<[number, number]>,
);

describe('resampleTo1Hz', () => {
  it('passes a clean 1 Hz series through unchanged', () => {
    const { timeS, watts } = stream([100, 200, 300]);
    expect(resampleTo1Hz(timeS, watts)).toEqual([100, 200, 300]);
  });

  it('holds a value across a short gap (2 s sampling)', () => {
    expect(resampleTo1Hz([0, 2, 4], [100, 200, 300])).toEqual([
      100, 100, 200, 200, 300,
    ]);
  });

  it('holds across exactly MAX_HOLD_GAP_S but removes a longer pause', () => {
    expect(resampleTo1Hz([0, MAX_HOLD_GAP_S], [100, 200])).toHaveLength(
      MAX_HOLD_GAP_S + 1,
    );
    // 60 s café stop: only the sample's own second survives.
    expect(resampleTo1Hz([0, 60, 61], [100, 200, 300])).toEqual([
      100, 200, 300,
    ]);
  });

  it('counts null, negative and glitch values as 0 W', () => {
    expect(resampleTo1Hz([0, 1, 2, 3], [null, -12, 65535, 150])).toEqual([
      0, 0, 0, 150,
    ]);
  });

  it('skips duplicate and out-of-order timestamps', () => {
    expect(resampleTo1Hz([0, 0, 1, 0.4, 2], [100, 999, 200, 999, 300])).toEqual(
      [100, 200, 300],
    );
  });

  it('keeps one value per second for a sub-second (4 Hz) meter', () => {
    const timeS = Array.from({ length: 12 }, (_, i) => i * 0.25);
    const watts = timeS.map((t) => (t < 1 ? 100 : t < 2 ? 200 : 300));
    expect(resampleTo1Hz(timeS, watts)).toEqual([100, 200, 300]);
  });

  it('is empty for an empty stream', () => {
    expect(resampleTo1Hz([], [])).toEqual([]);
  });
});

describe('normalizedPower', () => {
  it('equals the power of a constant effort', () => {
    expect(normalizedPower(constant(200, 3600))).toBeCloseTo(200, 9);
  });

  it('exceeds average power for a variable effort', () => {
    // Independent check (plain Python, trailing 30 s window): 315.1522
    expect(normalizedPower(INTERVALS)).toBeCloseTo(315.1522, 3);
  });

  it('is null under one window, defined from exactly one window', () => {
    expect(normalizedPower(constant(200, 29))).toBeNull();
    expect(normalizedPower(constant(200, 30))).toBeCloseTo(200, 9);
  });
});

describe('intensityFactor / trainingStressScore', () => {
  it('scores one hour at FTP as IF 1.0 and TSS 100', () => {
    expect(intensityFactor(250, 250)).toBe(1);
    expect(trainingStressScore(3600, 250, 250)).toBeCloseTo(100, 9);
  });

  it('scales TSS with time and with IF squared', () => {
    expect(trainingStressScore(1800, 250, 250)).toBeCloseTo(50, 9);
    expect(trainingStressScore(3600, 200, 250)).toBeCloseTo(64, 9); // 0.8² · 100
  });

  it('is null without a usable FTP', () => {
    expect(intensityFactor(250, null)).toBeNull();
    expect(intensityFactor(250, 0)).toBeNull();
    expect(trainingStressScore(3600, 250, null)).toBeNull();
  });
});

describe('meanMaxCurve', () => {
  it('finds a 5 s sprint inside an endurance ride', () => {
    const series = blocks([
      [150, 600],
      [900, 5],
      [150, 600],
    ]);
    const curve = meanMaxCurve(series);
    const at = (d: number) => curve.find((p) => p.durationS === d)?.watts;
    expect(at(1)).toBe(900);
    expect(at(5)).toBe(900);
    expect(at(10)).toBe(525); // (5·900 + 5·150) / 10
    expect(at(600)).toBe(Math.round((5 * 900 + 595 * 150) / 600));
  });

  it('is bounded by max power above and average power below', () => {
    for (const p of meanMaxCurve(INTERVALS)) {
      expect(p.watts).toBeLessThanOrEqual(400);
      expect(p.watts).toBeGreaterThanOrEqual(250);
    }
  });

  it('is NOT forced monotonic — a periodic effort can beat a shorter duration', () => {
    // Every 120 s window of the 60/60 intervals averages exactly 250 W, but a
    // 300 s window can hold three 400 W minutes: (3·400 + 2·100) · 60 / 300.
    // Mean-max is a true per-duration maximum, stored as computed.
    const curve = meanMaxCurve(INTERVALS);
    const at = (d: number) => curve.find((p) => p.durationS === d)?.watts;
    expect(at(120)).toBe(250);
    expect(at(300)).toBe(280);
  });

  it('skips durations longer than the series', () => {
    const curve = meanMaxCurve(constant(200, 700));
    expect(curve.map((p) => p.durationS)).toEqual(
      POWER_CURVE_DURATIONS_S.filter((d) => d <= 700),
    );
    expect(curve.every((p) => p.watts === 200)).toBe(true);
  });

  it('covers all 14 standard durations for a 2 h ride', () => {
    expect(meanMaxCurve(constant(180, 7200))).toHaveLength(14);
  });
});

describe('computeRidePowerMetrics', () => {
  it('computes the full set for a 1 h interval ride with an FTP', () => {
    const { timeS, watts } = stream(INTERVALS);
    const m = computeRidePowerMetrics(timeS, watts, 250);
    expect(m).toMatchObject({
      npW: 315,
      intensityFactor: 1.261, // 315.1522 / 250
      tss: 158.9, // independent check: 158.913
      ftpW: 250,
      durationS: 3600,
      avgPowerW: 250,
      maxPowerW: 400,
      kilojoules: 900, // 250 W · 3600 s
    });
    expect(m!.curve).toHaveLength(12); // 1 s … 60 min
  });

  it('counts time in the seven power zones against the FTP (MZY-63)', () => {
    // 150 W for 600 s at FTP 250 is 60% of FTP: Zone 2 (endurance).
    const { timeS, watts } = stream(constant(150, 600));
    const m = computeRidePowerMetrics(timeS, watts, 250);
    expect(m!.zoneSeconds).toEqual([0, 600, 0, 0, 0, 0, 0]);
    expect(m!.zoneSeconds!.reduce((a, b) => a + b, 0)).toBe(m!.durationS);
  });

  it('spreads an interval ride over several zones, summing to the ride', () => {
    const { timeS, watts } = stream(INTERVALS);
    const m = computeRidePowerMetrics(timeS, watts, 250);
    expect(m!.zoneSeconds!.filter((s) => s > 0).length).toBeGreaterThan(1);
    expect(m!.zoneSeconds!.reduce((a, b) => a + b, 0)).toBe(3600);
  });

  it('keeps NP and the curve but nulls IF/TSS without an FTP', () => {
    const { timeS, watts } = stream(constant(200, 600));
    const m = computeRidePowerMetrics(timeS, watts, null);
    expect(m).toMatchObject({
      npW: 200,
      intensityFactor: null,
      tss: null,
      ftpW: null,
      zoneSeconds: null, // zones need an FTP, like IF/TSS
    });
    expect(m!.curve.length).toBeGreaterThan(0);
  });

  it('is not changed by a long stop in the middle', () => {
    const half = constant(220, 1800);
    const continuous = stream([...half, ...half]);
    // Same samples, but a 20-minute stop between the halves.
    const paused = {
      timeS: [...half.map((_, i) => i), ...half.map((_, i) => 1800 + 1200 + i)],
      watts: [...half, ...half],
    };
    const a = computeRidePowerMetrics(continuous.timeS, continuous.watts, 250);
    const b = computeRidePowerMetrics(paused.timeS, paused.watts, 250);
    expect(b).toEqual(a);
    expect(b!.durationS).toBe(3600);
  });

  it('is null for a stream shorter than the NP window', () => {
    const { timeS, watts } = stream(constant(300, 20));
    expect(computeRidePowerMetrics(timeS, watts, 250)).toBeNull();
  });
});

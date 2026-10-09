import {
  calibratedRequestKm,
  closerToTarget,
  needsCalibration,
  relativeError,
} from '@/services/routing/calibrate';

// Pure round-trip length calibration — the correction that stops ORS returning a
// 9.4 km loop for a 7.5 km request (see calibrate.ts).

describe('relativeError', () => {
  it('is the fractional miss against the target', () => {
    expect(relativeError(11, 10)).toBeCloseTo(0.1);
    expect(relativeError(9, 10)).toBeCloseTo(0.1);
    expect(relativeError(10, 10)).toBe(0);
  });

  it('is Infinity for a non-positive target', () => {
    expect(relativeError(10, 0)).toBe(Infinity);
  });
});

describe('needsCalibration', () => {
  it('accepts a candidate inside the tolerance', () => {
    expect(needsCalibration(10.5, 10, 0.1)).toBe(false);
  });

  it('flags a candidate outside the tolerance', () => {
    expect(needsCalibration(12, 10, 0.1)).toBe(true);
  });

  it('flags the coastal overshoot case (7.5 km asked, 9.39 km returned)', () => {
    expect(needsCalibration(9.39, 7.5)).toBe(true);
  });
});

describe('calibratedRequestKm', () => {
  it('scales the request down when the engine overshot', () => {
    // Asked 7.5, got 9.39 → ask for 7.5 × (7.5/9.39) ≈ 5.99 next time.
    const next = calibratedRequestKm(7.5, 9.39, 7.5)!;
    expect(next).toBeCloseTo(5.99, 1);
    expect(next).toBeLessThan(7.5);
  });

  it('scales the request up when the engine undershot', () => {
    const next = calibratedRequestKm(10, 8, 10)!;
    expect(next).toBeGreaterThan(10);
    expect(next).toBeCloseTo(12.5, 1);
  });

  it('clamps an absurd correction rather than chasing a wild outlier', () => {
    // 39.73 km returned for a 7.5 km ask would scale by 0.19 — clamped to 0.25.
    const next = calibratedRequestKm(7.5, 39.73, 7.5)!;
    expect(next).toBeCloseTo(7.5 * 0.25, 5);
  });

  it('returns null when the correction would be negligible', () => {
    expect(calibratedRequestKm(10, 10.01, 10)).toBeNull();
  });

  it('returns null for non-positive inputs', () => {
    expect(calibratedRequestKm(10, 0, 10)).toBeNull();
    expect(calibratedRequestKm(0, 10, 10)).toBeNull();
    expect(calibratedRequestKm(10, 10, 0)).toBeNull();
  });
});

describe('closerToTarget', () => {
  it('picks the attempt nearer the target', () => {
    const a = { distanceM: 9390 };
    const b = { distanceM: 7600 };
    expect(closerToTarget(a, b, 7.5)).toBe(b);
  });

  it('keeps the first argument on an exact tie (stable)', () => {
    const a = { distanceM: 7400 };
    const b = { distanceM: 7600 };
    expect(closerToTarget(a, b, 7.5)).toBe(a);
  });
});

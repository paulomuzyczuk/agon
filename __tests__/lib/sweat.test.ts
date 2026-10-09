import { sweatLossLitres, sweatRateLPerH } from '@/lib/sweat';

describe('sweatLossLitres', () => {
  it('is body-mass lost plus fluid drunk', () => {
    // lost 0.6 kg, drank 0.5 L → 1.1 L sweat
    expect(sweatLossLitres(76.4, 75.8, 0.5)).toBeCloseTo(1.1, 5);
  });

  it('never goes negative (gained weight, no fluid)', () => {
    expect(sweatLossLitres(75, 75.5, 0)).toBe(0);
  });
});

describe('sweatRateLPerH', () => {
  it('divides total loss by duration in hours', () => {
    // 1.1 L over 3600 s (1 h) → 1.1 L/h
    expect(
      sweatRateLPerH({
        preKg: 76.4,
        postKg: 75.8,
        fluidL: 0.5,
        durationS: 3600,
      }),
    ).toBe(1.1);
  });

  it('rounds to 3 decimals (NUMERIC(5,3))', () => {
    // 1.1 L over 5400 s (1.5 h) → 0.7333… → 0.733
    expect(
      sweatRateLPerH({
        preKg: 76.4,
        postKg: 75.8,
        fluidL: 0.5,
        durationS: 5400,
      }),
    ).toBe(0.733);
  });

  it('is null when duration is unknown', () => {
    expect(
      sweatRateLPerH({ preKg: 76, postKg: 75, fluidL: 0, durationS: null }),
    ).toBeNull();
  });
});

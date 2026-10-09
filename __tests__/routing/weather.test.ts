import {
  windExposurePenalty,
  heatCaveat,
  HEAT_CAVEAT_THRESHOLD_C,
  type RouteForecast,
} from '@/services/routing/weather';

describe('windExposurePenalty', () => {
  it('is zero with no forecast', () => {
    expect(windExposurePenalty(90, null)).toBe(0);
  });

  it('is zero when wind fields are missing', () => {
    const f: RouteForecast = { tempC: 20, windKph: null, windFromDeg: 90 };
    expect(windExposurePenalty(90, f)).toBe(0);
    const g: RouteForecast = { tempC: 20, windKph: 20, windFromDeg: null };
    expect(windExposurePenalty(90, g)).toBe(0);
  });

  it('is the full wind speed for a dead-on headwind (0° apart)', () => {
    const f: RouteForecast = { tempC: 20, windKph: 25, windFromDeg: 90 };
    expect(windExposurePenalty(90, f)).toBeCloseTo(25);
  });

  it('is zero for a pure crosswind (90° apart)', () => {
    const f: RouteForecast = { tempC: 20, windKph: 25, windFromDeg: 90 };
    expect(windExposurePenalty(180, f)).toBeCloseTo(0);
  });

  it('is zero for a tailwind (180° apart) — penalty-only, never a bonus', () => {
    const f: RouteForecast = { tempC: 20, windKph: 25, windFromDeg: 90 };
    expect(windExposurePenalty(270, f)).toBe(0);
  });

  it('scales between 0 and full speed for a partial headwind (45° apart)', () => {
    const f: RouteForecast = { tempC: 20, windKph: 20, windFromDeg: 90 };
    const penalty = windExposurePenalty(45, f);
    expect(penalty).toBeGreaterThan(0);
    expect(penalty).toBeLessThan(20);
    expect(penalty).toBeCloseTo(20 * Math.SQRT1_2, 5); // cos(45°) = √2/2
  });

  it('wraps bearings correctly across the 0/360 boundary', () => {
    const f: RouteForecast = { tempC: 20, windKph: 15, windFromDeg: 5 };
    expect(windExposurePenalty(355, f)).toBeCloseTo(15, 0); // 10° apart, near-headwind
  });
});

describe('heatCaveat', () => {
  it('returns null with no forecast or no temperature', () => {
    expect(heatCaveat(null)).toBeNull();
    expect(
      heatCaveat({ tempC: null, windKph: 10, windFromDeg: 90 }),
    ).toBeNull();
  });

  it('returns null below the threshold', () => {
    expect(
      heatCaveat({
        tempC: HEAT_CAVEAT_THRESHOLD_C - 1,
        windKph: null,
        windFromDeg: null,
      }),
    ).toBeNull();
  });

  it('flags a caveat at/above the threshold', () => {
    const msg = heatCaveat({
      tempC: HEAT_CAVEAT_THRESHOLD_C,
      windKph: null,
      windFromDeg: null,
    });
    expect(msg).not.toBeNull();
    expect(msg).toContain(`${HEAT_CAVEAT_THRESHOLD_C}°C`);
  });

  it('rounds the reported temperature', () => {
    const msg = heatCaveat({ tempC: 31.6, windKph: null, windFromDeg: null });
    expect(msg).toContain('32°C');
  });
});

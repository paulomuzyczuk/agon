import {
  elevationGainM,
  smoothedElevationProfile,
} from '../../lib/elevationGain';

// A run at ~2.8 m/s sampled once per second, the live flush's 1 s axis.
const STEP_M = 2.8;

/** Deterministic noise (no Math.random in tests): a fixed LCG, Box-Muller. */
function noise(sigma: number, seed = 1) {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s || 1) / 0x7fffffff;
  };
  return () =>
    sigma * Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
}

function track(n: number, profile: (dM: number) => number, sigma = 0) {
  const n0 = noise(sigma);
  const distanceM = Array.from({ length: n }, (_, i) => i * STEP_M);
  const altitudeM = distanceM.map((d) => profile(d) + n0());
  return { distanceM, altitudeM };
}

describe('elevationGainM', () => {
  it('a clean ramp climbs exactly its height', () => {
    const { distanceM, altitudeM } = track(1001, (d) => 30 + d * 0.02);
    // 2.8 km at 2 % = 56 m.
    expect(elevationGainM(distanceM, altitudeM)).toBeCloseTo(56, 0);
  });

  it('a noisy hill (40 m up and back down) comes out near 40 m', () => {
    // 4 km out-and-back: 2 km up 40 m, 2 km down, ±1.5 m of altitude noise.
    const { distanceM, altitudeM } = track(
      1430,
      (d) => 35 + 40 * Math.max(0, 1 - Math.abs(d - 2000) / 2000),
      1.5,
    );
    const raw = altitudeM.reduce(
      (g, a, i) =>
        i > 0 && a > altitudeM[i - 1]! ? g + a - altitudeM[i - 1]! : g,
      0,
    );
    const gain = elevationGainM(distanceM, altitudeM)!;
    expect(raw).toBeGreaterThan(400); // why a plain sum is useless
    expect(gain).toBeGreaterThan(36);
    expect(gain).toBeLessThan(48);
  });

  it('a flat noisy track stays near 0 instead of summing the wobble', () => {
    const { distanceM, altitudeM } = track(1800, () => 41.3, 1);
    const gain = elevationGainM(distanceM, altitudeM)!;
    expect(gain).toBeGreaterThanOrEqual(0);
    expect(gain).toBeLessThan(5);
  });

  it('returns null with too few usable points', () => {
    expect(elevationGainM([], [])).toBeNull();
    expect(elevationGainM([0], [40])).toBeNull();
    // Two points, but only one carries both a distance and an altitude.
    expect(elevationGainM([null, 3], [40, null])).toBeNull();
  });

  it('skips points without a distance or an altitude', () => {
    // The flush's distance_m is null before the first fix; altitude can be
    // missing in a second no fix landed in.
    const distanceM = [null, null, 0, 3, 6, null, 9, 12];
    const altitudeM = [null, 40, 40, 41, null, 50, 42, 43];
    expect(elevationGainM(distanceM, altitudeM)).toBeCloseTo(3, 1);
  });

  it('accepts NUMERIC[] values that pg returns as strings', () => {
    const distanceM = ['0', '5', '10'] as unknown as number[];
    const altitudeM = ['40.0', '41.5', '43.0'] as unknown as number[];
    expect(elevationGainM(distanceM, altitudeM)).toBeCloseTo(3, 1);
  });

  it('without the band, the smoothed wiggle of a flat track adds up', () => {
    const { distanceM, altitudeM } = track(1800, () => 41.3, 1);
    expect(
      elevationGainM(distanceM, altitudeM, { hysteresisM: 0 })!,
    ).toBeGreaterThan(10);
  });

  it('a hysteresis band ignores rises smaller than the band', () => {
    // A 2 m step up and down every 500 m on a 3 km flat.
    const { distanceM, altitudeM } = track(1072, (d) =>
      Math.floor(d / 500) % 2 === 0 ? 40 : 42,
    );
    expect(elevationGainM(distanceM, altitudeM)!).toBeGreaterThan(3);
    expect(elevationGainM(distanceM, altitudeM, { hysteresisM: 3 })).toBe(0);
  });
});

describe('smoothedElevationProfile', () => {
  it('keeps the raw first and last altitude, one value per usable point', () => {
    const { distanceM, altitudeM } = track(500, (d) => 40 + d * 0.01, 1);
    const profile = smoothedElevationProfile(distanceM, altitudeM);
    expect(profile).toHaveLength(500);
    expect(profile[0]).toBe(altitudeM[0]);
    expect(profile.at(-1)).toBe(altitudeM.at(-1));
  });
});

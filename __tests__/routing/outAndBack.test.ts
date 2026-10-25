import { outAndBackFrom } from '@/services/routing/outAndBack';
import type { RouteCandidate } from '@/services/routing/types';

// ~0.009 degrees of latitude is 1 km; a straight north-south street.
function street(km: number): RouteCandidate {
  const n = 10;
  return {
    seed: 0,
    distanceM: km * 1000,
    elevationGainM: 12,
    coordinates: Array.from({ length: n + 1 }, (_, i) => [
      13.3,
      52.47 + (km * 0.009 * i) / n,
    ]),
    provider: 'ors',
  };
}

describe('outAndBackFrom', () => {
  it('cuts a longer street at half the total and mirrors it back', () => {
    const r = outAndBackFrom(street(2.6), 5000);
    expect(r.distanceM).toBe(5000);
    const c = r.coordinates;
    expect(c[0]).toEqual(c[c.length - 1]);
    // turnaround is ~2.5 km out: 2.5 * 0.009 degrees north of the start
    expect(r.turnaround.lat).toBeCloseTo(52.47 + 2.5 * 0.009, 3);
  });

  it('keeps a shorter street whole and doubles it', () => {
    const r = outAndBackFrom(street(2.0), 5000);
    expect(r.distanceM).toBe(4000);
    expect(r.turnaround.lat).toBeCloseTo(52.47 + 2.0 * 0.009, 3);
  });

  it('drops elevation: a trimmed route has no engine total', () => {
    expect(outAndBackFrom(street(2.6), 5000).elevationGainM).toBeNull();
  });

  it('rejects a route with fewer than two points', () => {
    expect(() =>
      outAndBackFrom({ ...street(2.6), coordinates: [[13.3, 52.47]] }, 5000),
    ).toThrow(/at least 2 points, got 1/);
  });
});

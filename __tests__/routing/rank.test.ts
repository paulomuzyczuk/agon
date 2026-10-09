import { rankCandidates } from '@/services/routing/rank';
import type { RouteCandidate, Coord } from '@/services/routing/types';

// Pure ranking: distance-accuracy first, then flattest, then wind, then seed.

function c(
  seed: number,
  distanceM: number,
  gain: number | null,
  coordinates: number[][] = [],
): RouteCandidate {
  return {
    seed,
    distanceM,
    elevationGainM: gain,
    coordinates,
    provider: 'test',
  };
}

describe('rankCandidates', () => {
  it('orders by absolute distance error to the target', () => {
    const ranked = rankCandidates(
      [c(1, 27000, 100), c(2, 24800, 100), c(3, 22000, 100)],
      25, // target 25 km = 25000 m
    );
    // 24800 (Δ200) < 27000 (Δ2000) < 22000 (Δ3000)
    expect(ranked.map((r) => r.seed)).toEqual([2, 1, 3]);
    expect(ranked[0]!.distanceErrorM).toBe(200);
  });

  it('tie-breaks equal distance error by least elevation gain', () => {
    const ranked = rankCandidates(
      [c(1, 25500, 300), c(2, 24500, 120)], // both Δ500
      25,
    );
    expect(ranked.map((r) => r.seed)).toEqual([2, 1]);
  });

  it('treats null elevation as least-preferred in the flatness tie-break', () => {
    const ranked = rankCandidates(
      [c(1, 25500, null), c(2, 24500, 200)], // both Δ500
      25,
    );
    expect(ranked.map((r) => r.seed)).toEqual([2, 1]);
  });

  it('keeps only the top N (default 3)', () => {
    const ranked = rankCandidates(
      [c(1, 25000, 0), c(2, 25100, 0), c(3, 25200, 0), c(4, 25300, 0)],
      25,
    );
    expect(ranked).toHaveLength(3);
    expect(ranked.map((r) => r.seed)).toEqual([1, 2, 3]);
  });

  it('respects a custom keep count', () => {
    const ranked = rankCandidates([c(1, 25000, 0), c(2, 25100, 0)], 25, 1);
    expect(ranked).toHaveLength(1);
  });

  // Elevation only earns its place in the ranking if near-equal distances defer
  // to it. Exact metre ties never occur in practice, so the comparison is banded.
  it('prefers the flatter route when both are within the distance band', () => {
    // Target 10 km, band = 500 m. 10.05 km (Δ50, hilly) vs 10.30 km (Δ300, flat).
    const ranked = rankCandidates([c(1, 10050, 400), c(2, 10300, 60)], 10);
    expect(ranked.map((r) => r.seed)).toEqual([2, 1]);
  });

  it('still puts distance accuracy first once routes fall in different bands', () => {
    // 10.05 km (Δ50, band 0) vs 11.20 km (Δ1200, band 2) — accuracy wins.
    const ranked = rankCandidates([c(1, 11200, 10), c(2, 10050, 400)], 10);
    expect(ranked.map((r) => r.seed)).toEqual([2, 1]);
  });

  it('orders within a band by total ascent, not ascent per km', () => {
    // Same band (target 20 km, band 1000 m), identical total ascent. Ranking by
    // per-km would put the LONGEST first (same climb spread further); that is an
    // artefact, not a flatter run, so total ascent decides and the exact distance
    // error breaks the tie.
    const ranked = rankCandidates(
      [c(1, 20100, 50), c(2, 20200, 50), c(3, 20300, 50)],
      20,
    );
    expect(ranked.map((r) => r.seed)).toEqual([1, 2, 3]);
  });

  it('exposes ascent per km on each ranked candidate', () => {
    const [top] = rankCandidates([c(1, 10000, 250)], 10);
    expect(top!.elevationGainPerKmM).toBeCloseTo(25);
  });

  it('reports null ascent per km when the engine gave no elevation', () => {
    const [top] = rankCandidates([c(1, 10000, null)], 10);
    expect(top!.elevationGainPerKmM).toBeNull();
  });
});

describe('rankCandidates with a weather forecast', () => {
  const start: Coord = { lat: 52.5, lng: 13.4 };
  // Apex due EAST of start → routeBearing ≈ 90°.
  const eastLoop = [
    [start.lng, start.lat],
    [start.lng + 0.01, start.lat],
  ];
  // Apex due WEST of start → routeBearing ≈ 270°.
  const westLoop = [
    [start.lng, start.lat],
    [start.lng - 0.01, start.lat],
  ];

  it('omitting `weather` ranks exactly as before (no wind penalty computed)', () => {
    const ranked = rankCandidates(
      [c(1, 10000, 100, eastLoop), c(2, 10000, 100, westLoop)],
      10,
    );
    expect(ranked[0]!.windPenalty).toBeFalsy(); // undefined or null, never scored
  });

  it('prefers the route heading away from a forecast headwind, same band/ascent', () => {
    // Wind FROM the east (90°) — the east-heading loop runs straight into it.
    const ranked = rankCandidates(
      [c(1, 10000, 100, eastLoop), c(2, 10000, 100, westLoop)],
      10,
      3,
      { start, forecast: { tempC: 15, windKph: 20, windFromDeg: 90 } },
    );
    expect(ranked.map((r) => r.seed)).toEqual([2, 1]); // west (no headwind) first
    expect(ranked[0]!.windPenalty).toBe(0);
    expect(ranked[1]!.windPenalty).toBeCloseTo(20); // full headwind
  });

  it('a null forecast (fetch failed) never changes the ranking', () => {
    const ranked = rankCandidates(
      [c(1, 10000, 100, eastLoop), c(2, 10000, 100, westLoop)],
      10,
      3,
      { start, forecast: null },
    );
    expect(ranked.every((r) => r.windPenalty === 0)).toBe(true);
    expect(ranked.map((r) => r.seed)).toEqual([1, 2]); // falls through to seed
  });

  it('distance-accuracy band still wins over wind exposure', () => {
    // seed 1 is Δ50 (band 0), seed 2 is Δ1200 (band 2, target 10km/band 500m) —
    // even a full headwind on seed 1 can't outrank a different, worse band.
    const ranked = rankCandidates(
      [c(1, 10050, 0, eastLoop), c(2, 11200, 0, westLoop)],
      10,
      3,
      { start, forecast: { tempC: 15, windKph: 40, windFromDeg: 90 } },
    );
    expect(ranked.map((r) => r.seed)).toEqual([1, 2]);
  });
});

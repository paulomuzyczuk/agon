import { suggestRoutes } from '@/services/routing/generate';
import type { RouteProvider } from '@/services/routing/provider';
import type {
  AreaShape,
  Coord,
  RouteCandidate,
  RouteRequest,
} from '@/services/routing/types';
import { haversineM, pointInArea } from '@/services/routing/detour';

// generate.ts with an injected fake provider — asserts start resolution
// (explicit coords / home default), ranking, and the constrained (through/finish)
// composition. No network/DB.

const OLD_ENV = process.env;
beforeEach(() => {
  process.env = {
    ...OLD_ENV,
    AGON_HOME_LAT: '52.5163',
    AGON_HOME_LNG: '13.3777',
  };
});
afterEach(() => {
  process.env = OLD_ENV;
});

function fakeProvider(): {
  provider: RouteProvider;
  lastReq: () => RouteRequest | null;
  lastDirections: () => Coord[] | null;
  firstDirections: () => Coord[] | null;
  lastDirectionsProfile: () => string | undefined;
} {
  let seen: RouteRequest | null = null;
  let directionsWaypoints: Coord[] | null = null;
  let firstWaypoints: Coord[] | null = null;
  let directionsProfile: string | undefined;
  const provider: RouteProvider = {
    name: 'fake',
    async generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]> {
      seen = req;
      // Return loops sized ~ to the requested target so padding math is realistic.
      const m = req.targetKm * 1000;
      return (req.seeds ?? [1, 2]).map((seed) => ({
        seed,
        distanceM: m + seed * 100, // slight variation per seed
        elevationGainM: 50,
        coordinates: [
          [13.3777, 52.5163, 40],
          [13.3851, 52.5269, 42],
          [13.3777, 52.5163, 40],
        ],
        provider: 'fake',
      }));
    },
    async directions(
      waypoints: Coord[],
      profile?: string,
    ): Promise<RouteCandidate> {
      directionsWaypoints = waypoints;
      firstWaypoints ??= waypoints;
      directionsProfile = profile;
      return {
        seed: 0,
        distanceM: 6000, // 6 km spine
        elevationGainM: 30,
        coordinates: [
          [13.3777, 52.5163, 40], // start
          [13.4351, 52.5369, 45], // through
          [13.4651, 52.5469, 48], // finish
        ],
        provider: 'fake',
      };
    },
  };
  return {
    provider,
    lastReq: () => seen,
    lastDirections: () => directionsWaypoints,
    firstDirections: () => firstWaypoints,
    lastDirectionsProfile: () => directionsProfile,
  };
}

describe('suggestRoutes — loops', () => {
  it('uses explicit coordinates and ranks by distance accuracy', async () => {
    const { provider, lastReq } = fakeProvider();
    const result = await suggestRoutes(
      { targetKm: 25, start: { coord: { lat: 52.5269, lng: 13.4551 } } },
      provider,
    );
    expect(lastReq()!.start).toEqual({ lat: 52.5269, lng: 13.4551 });
    // seed 1 (Δ100) < seed 2 (Δ200) < seed 3 (Δ300)
    expect(result.candidates.map((c) => c.seed)).toEqual([1, 2, 3]);
    expect(result.start.label).toContain('52.5269');
    expect(result.through).toBeUndefined(); // not a constrained route
  });

  it('falls back to the home location when no start is given', async () => {
    const { provider, lastReq } = fakeProvider();
    const result = await suggestRoutes({ targetKm: 25 }, provider);
    expect(lastReq()!.start).toEqual({ lat: 52.5163, lng: 13.3777 });
    expect(result.start.label).toBe('home');
  });

  it('rejects a non-positive target distance', async () => {
    const { provider } = fakeProvider();
    await expect(suggestRoutes({ targetKm: 0 }, provider)).rejects.toThrow(
      /positive/,
    );
  });

  it('defaults to the foot-walking profile', async () => {
    const { provider, lastReq } = fakeProvider();
    const result = await suggestRoutes({ targetKm: 25 }, provider);
    expect(lastReq()!.profile).toBe('foot-walking');
    expect(result.profile).toBe('foot-walking');
  });

  it('threads a cycling profile through to the provider and the result', async () => {
    const { provider, lastReq } = fakeProvider();
    const result = await suggestRoutes(
      { targetKm: 25, profile: 'cycling-regular' },
      provider,
    );
    expect(lastReq()!.profile).toBe('cycling-regular');
    expect(result.profile).toBe('cycling-regular');
  });
});

describe('suggestRoutes — constrained (through / finish)', () => {
  it('passes the cycling profile to both the spine and the pad loop', async () => {
    const { provider, lastReq, lastDirectionsProfile } = fakeProvider();
    await suggestRoutes(
      {
        targetKm: 25,
        start: { coord: { lat: 52.5163, lng: 13.3777 } },
        through: [{ coord: { lat: 52.5369, lng: 13.4351 } }],
        finishNear: { coord: { lat: 52.5469, lng: 13.4651 } },
        profile: 'cycling-regular',
      },
      provider,
    );
    expect(lastDirectionsProfile()).toBe('cycling-regular');
    expect(lastReq()!.profile).toBe('cycling-regular');
  });

  it('falls back to padding the spine with a loop when no detour reaches the target', async () => {
    // This fake's directions are a fixed 6 km whatever the waypoints, so no
    // detour can ever lengthen the route — the pad-loop fallback must kick in.
    const { provider, lastReq, firstDirections } = fakeProvider();
    const result = await suggestRoutes(
      {
        targetKm: 25,
        start: { coord: { lat: 52.5163, lng: 13.3777 } },
        through: [{ coord: { lat: 52.5369, lng: 13.4351 } }],
        finishNear: { coord: { lat: 52.5469, lng: 13.4651 } },
      },
      provider,
    );
    // the spine: directions called first with [start, through, finish]
    expect(firstDirections()).toEqual([
      { lat: 52.5163, lng: 13.3777 },
      { lat: 52.5369, lng: 13.4351 },
      { lat: 52.5469, lng: 13.4651 },
    ]);
    // pad loop requested for target − spine = 25 − 6 = 19 km
    expect(lastReq()!.targetKm).toBe(19);
    expect(result.through).toHaveLength(1);
    expect(result.finish).toMatchObject({ lat: 52.5469, lng: 13.4651 });
    expect(result.spineOnly).toBeUndefined();
    // stitched distance = pad loop (~19.1 km) + spine (6 km) ≈ 25.1 km
    expect(result.candidates[0]!.distanceM).toBeGreaterThan(24000);
    // geometry ends at the finish point (last spine coord), not back home
    const geo = result.candidates[0]!.coordinates;
    expect(geo[geo.length - 1]).toEqual([13.4651, 52.5469, 48]);
  });

  it('returns the spine alone when it already meets the target', async () => {
    const { provider } = fakeProvider();
    // spine is 6 km; ask for 5 km → padM negative → spine only
    const result = await suggestRoutes(
      {
        targetKm: 5,
        start: { coord: { lat: 52.5163, lng: 13.3777 } },
        finishNear: { coord: { lat: 52.5469, lng: 13.4651 } },
      },
      provider,
    );
    expect(result.spineOnly).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.distanceM).toBe(6000);
  });

  it('defaults the finish back to the start (a loop through the waypoints)', async () => {
    const { provider, lastDirections } = fakeProvider();
    await suggestRoutes(
      {
        targetKm: 25,
        start: { coord: { lat: 52.5163, lng: 13.3777 } },
        through: [{ coord: { lat: 52.5369, lng: 13.4351 } }],
      },
      provider,
    );
    const wp = lastDirections()!;
    // last waypoint === start (finish defaults to start)
    expect(wp[wp.length - 1]).toEqual({ lat: 52.5163, lng: 13.3777 });
  });
});

describe('suggestRoutes — detour routes (MZY-215)', () => {
  /**
   * A router whose distance follows the geometry: 1.3 × the straight-line
   * length through the waypoints (a typical street-grid detour factor), with
   * the waypoints themselves as the geometry. Enough for the offset search to
   * behave as it would against a real engine. Round trips are counted so a
   * test can assert the pad-loop fallback was NOT needed.
   */
  function geometricProvider(): {
    provider: RouteProvider;
    roundTrips: () => number;
    directionsCalls: () => Coord[][];
  } {
    let rt = 0;
    const calls: Coord[][] = [];
    const provider: RouteProvider = {
      name: 'geo',
      async generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]> {
        rt += 1;
        return (req.seeds ?? [1]).map((seed) => ({
          seed,
          distanceM: req.targetKm * 1000,
          elevationGainM: 10,
          coordinates: [
            [req.start.lng, req.start.lat],
            [req.start.lng, req.start.lat],
          ],
          provider: 'geo',
        }));
      },
      async directions(waypoints: Coord[]): Promise<RouteCandidate> {
        calls.push(waypoints);
        let m = 0;
        for (let i = 1; i < waypoints.length; i++) {
          m += haversineM(waypoints[i - 1]!, waypoints[i]!);
        }
        return {
          seed: 0,
          distanceM: m * 1.3,
          elevationGainM: 20,
          coordinates: waypoints.map((w) => [w.lng, w.lat]),
          provider: 'geo',
        };
      },
    };
    return {
      provider,
      roundTrips: () => rt,
      directionsCalls: () => calls,
    };
  }

  const START = { lat: 52.5163, lng: 13.3777 };
  const FINISH = { lat: 52.4835, lng: 13.3760 }; // ~3.6 km south of START

  it('stretches a one-way route to the target with a detour, not a pad loop', async () => {
    const { provider, roundTrips } = geometricProvider();
    const result = await suggestRoutes(
      {
        targetKm: 20,
        start: { coord: START },
        finishNear: { coord: FINISH },
      },
      provider,
    );
    expect(result.oneWay).toBe(true);
    expect(roundTrips()).toBe(0); // detours landed; no fallback needed
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    for (const c of result.candidates) {
      // within ±5% of 20 km (the MZY-215 acceptance bar)
      expect(Math.abs(c.distanceM - 20000)).toBeLessThanOrEqual(1000);
      expect(c.vias).toHaveLength(1); // the one inserted detour point
      // still one-way: ends at the finish, not back at the start
      const end = c.coordinates[c.coordinates.length - 1]!;
      expect(end).toEqual([FINISH.lng, FINISH.lat]);
    }
    // left and right detours are genuinely different routes
    const [a, b] = result.candidates;
    expect(a!.vias![0]).not.toEqual(b!.vias![0]);
  });

  it("keeps an area via's detour point inside the area", async () => {
    // A ~4×4 km square "forest" west of the start/finish line.
    const forest: AreaShape = [
      [
        [13.2551, 52.4819],
        [13.3151, 52.4819],
        [13.3151, 52.5169],
        [13.2551, 52.5169],
        [13.2551, 52.4819],
      ],
    ];
    const { provider, roundTrips } = geometricProvider();
    const result = await suggestRoutes(
      {
        targetKm: 18,
        start: { coord: START },
        through: [{ coord: { lat: 52.4989, lng: 13.2851 }, area: forest }],
        finishNear: { coord: FINISH },
      },
      provider,
    );
    expect(result.through![0]!.area).toBe(forest);
    expect(roundTrips()).toBe(0);
    const best = result.candidates[0]!;
    expect(Math.abs(best.distanceM - 18000)).toBeLessThanOrEqual(900);
    // The area via is MOVED within the forest, no extra point is added.
    expect(best.vias).toHaveLength(1);
    expect(pointInArea(best.vias![0]!, forest)).toBe(true);
  });

  it('detours on the longest leg when the area is too small to hold it', async () => {
    const pond: AreaShape = [
      [
        [13.2846, 52.4984],
        [13.2856, 52.4984],
        [13.2856, 52.4994],
        [13.2846, 52.4994],
        [13.2846, 52.4984],
      ],
    ];
    const { provider, roundTrips } = geometricProvider();
    const result = await suggestRoutes(
      {
        targetKm: 30,
        start: { coord: START },
        through: [{ coord: { lat: 52.4989, lng: 13.2851 }, area: pond }],
        finishNear: { coord: FINISH },
      },
      provider,
    );
    expect(roundTrips()).toBe(0);
    const best = result.candidates[0]!;
    expect(Math.abs(best.distanceM - 30000)).toBeLessThanOrEqual(1500);
    // The pond via stays put; a detour point is added on a leg.
    expect(best.vias).toHaveLength(2);
    expect(best.vias).toContainEqual({ lat: 52.4989, lng: 13.2851 });
  });

  it('drops far-off detours once one is on target', async () => {
    const { provider } = geometricProvider();
    const result = await suggestRoutes(
      {
        targetKm: 20,
        start: { coord: START },
        finishNear: { coord: FINISH },
      },
      provider,
    );
    for (const c of result.candidates) {
      expect(Math.abs(c.distanceM - 20000) / 20000).toBeLessThanOrEqual(0.15);
    }
  });

  it('never sends labels or area rings to the provider', async () => {
    const { provider, directionsCalls } = geometricProvider();
    await suggestRoutes(
      {
        targetKm: 20,
        start: { coord: START },
        through: [{ coord: { lat: 52.4989, lng: 13.3551 } }],
        finishNear: { coord: FINISH },
      },
      provider,
    );
    for (const call of directionsCalls()) {
      for (const w of call)
        expect(Object.keys(w).sort()).toEqual(['lat', 'lng']);
    }
  });

  it('marks a finish back at the start as not one-way', async () => {
    const { provider } = geometricProvider();
    const result = await suggestRoutes(
      {
        targetKm: 15,
        start: { coord: START },
        through: [{ coord: { lat: 52.4989, lng: 13.3551 } }],
      },
      provider,
    );
    expect(result.oneWay).toBe(false);
  });
});

describe('suggestRoutes — round-trip length calibration', () => {
  /**
   * Provider whose loops miss the requested length by a fixed factor — the ORS
   * `round_trip` behaviour that made coastal suggestions unusable. Records every
   * requested length so the retry can be asserted.
   */
  function overshootingProvider(factor: number): {
    provider: RouteProvider;
    requestedKm: () => number[];
  } {
    const requested: number[] = [];
    const provider: RouteProvider = {
      name: 'overshoot',
      async generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]> {
        requested.push(req.targetKm);
        return (req.seeds ?? [1]).map((seed) => ({
          seed,
          distanceM: req.targetKm * 1000 * factor,
          elevationGainM: 50,
          coordinates: [
            [13.3777, 52.5163, 40],
            [13.3851, 52.5269, 42],
            [13.3777, 52.5163, 40],
          ],
          provider: 'overshoot',
        }));
      },
      async directions(): Promise<RouteCandidate> {
        throw new Error('not used');
      },
    };
    return { provider, requestedKm: () => requested };
  }

  it('re-requests a corrected length when the first loop misses the target', async () => {
    // Every loop comes back 25% long, like ORS on an island coast.
    const { provider, requestedKm } = overshootingProvider(1.25);
    const result = await suggestRoutes(
      {
        targetKm: 10,
        start: { coord: { lat: 34.9, lng: 33.63 } },
        seeds: [1],
      },
      provider,
    );
    // First ask 10 km → 12.5 km (25% off, outside tolerance) → retry at 10×(10/12.5) = 8 km.
    expect(requestedKm()[0]).toBe(10);
    expect(requestedKm()[1]).toBeCloseTo(8, 5);
    // The retry yields 8 × 1.25 = 10 km exactly, and is kept over the 12.5 km first try.
    expect(result.candidates[0]!.distanceM).toBeCloseTo(10000, 5);
  });

  it('does not re-request when the first loop is already within tolerance', async () => {
    const { provider, requestedKm } = overshootingProvider(1.02); // 2% off
    await suggestRoutes(
      { targetKm: 10, start: { coord: { lat: 52.5269, lng: 13.4551 } }, seeds: [1] },
      provider,
    );
    expect(requestedKm()).toEqual([10]); // one call only — no retry
  });

  it('keeps the original candidate when the retry fails', async () => {
    let calls = 0;
    const provider: RouteProvider = {
      name: 'flaky',
      async generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]> {
        calls += 1;
        if (calls > 1) throw new Error('rate limited');
        return [
          {
            seed: 1,
            distanceM: req.targetKm * 1000 * 1.25,
            elevationGainM: 10,
            coordinates: [[13.3551, 52.5269, 40]],
            provider: 'flaky',
          },
        ];
      },
      async directions(): Promise<RouteCandidate> {
        throw new Error('not used');
      },
    };
    const result = await suggestRoutes(
      { targetKm: 10, start: { coord: { lat: 52.5269, lng: 13.4551 } }, seeds: [1] },
      provider,
    );
    // A failed retry must never lose the route we already had.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.distanceM).toBeCloseTo(12500, 5);
  });
});

describe('suggestRoutes — diverse selection guards distance', () => {
  /** Provider returning fixed-length loops regardless of what was asked. */
  function fixedProvider(lengthsM: number[]): RouteProvider {
    return {
      name: 'fixed',
      async generateRoundTrips(req: RouteRequest): Promise<RouteCandidate[]> {
        // Ignore the requested length so calibration cannot rescue these — the
        // point is what selection does when the area simply can't hit target.
        const seeds = req.seeds ?? lengthsM.map((_, i) => i + 1);
        return seeds.map((seed) => {
          const idx = (seed - 1) % lengthsM.length;
          // Fan the apexes around the compass so each loop reads as a different
          // direction — the condition that used to beat distance accuracy.
          const angle = (idx / lengthsM.length) * 2 * Math.PI;
          return {
            seed,
            distanceM: lengthsM[idx]!,
            elevationGainM: 50,
            coordinates: [
              [13.3777, 52.5163],
              [
                13.3777 + 0.05 * Math.cos(angle),
                52.5163 + 0.05 * Math.sin(angle),
              ],
              [13.3777, 52.5163],
            ],
            provider: 'fixed',
          };
        });
      },
      async directions(): Promise<RouteCandidate> {
        throw new Error('not used');
      },
    };
  }

  it('prefers on-target routes over directional spread when few are close', async () => {
    // Target 12 km. Only one loop is anywhere near it; the rest are ~half.
    const provider = fixedProvider([12400, 6150, 5740, 6000, 5800, 6200]);
    const result = await suggestRoutes(
      {
        targetKm: 12,
        start: { coord: { lat: 52.5163, lng: 13.3777 } },
        diverse: true,
        seeds: [1, 2, 3, 4, 5, 6],
      },
      provider,
    );
    // The on-target loop must be present and ranked first, not displaced by a
    // 6 km loop that merely heads a different way.
    expect(result.candidates[0]!.distanceM).toBe(12400);
  });

  it('still diversifies when enough routes are on target', async () => {
    const provider = fixedProvider([12000, 12100, 12200, 11900, 12050, 11950]);
    const result = await suggestRoutes(
      {
        targetKm: 12,
        start: { coord: { lat: 52.5163, lng: 13.3777 } },
        diverse: true,
        seeds: [1, 2, 3, 4, 5, 6],
      },
      provider,
    );
    expect(result.candidates).toHaveLength(3);
    // All on-target, and each carries a compass direction from diverse selection.
    for (const c of result.candidates) {
      expect(Math.abs(c.distanceM - 12000)).toBeLessThanOrEqual(300);
      expect(c.direction).toBeDefined();
    }
    // Directions should not all be identical — that is the point of diversity.
    expect(
      new Set(result.candidates.map((c) => c.direction)).size,
    ).toBeGreaterThan(1);
  });
});

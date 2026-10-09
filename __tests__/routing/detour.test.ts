import {
  bearingDeg,
  detourPlans,
  haversineM,
  insideRunM,
  interiorAnchor,
  offsetPoint,
  pointInArea,
  solveOffset,
} from '@/services/routing/detour';
import type { AreaShape } from '@/services/routing/types';

// Pure detour geometry + the offset search (MZY-215). No network.

const SQUARE: AreaShape = [
  [
    [13.2, 52.45],
    [13.3, 52.45],
    [13.3, 52.5],
    [13.2, 52.5],
    [13.2, 52.45],
  ],
];

describe('geometry', () => {
  it('offsetPoint moves the requested distance along the bearing', () => {
    const from = { lat: 52.5, lng: 13.4 };
    const to = offsetPoint(from, 90, 2000);
    expect(haversineM(from, to)).toBeCloseTo(2000, 0);
    expect(bearingDeg(from, to)).toBeCloseTo(90, 0);
  });

  it('pointInArea handles inside, outside and multi-ring areas', () => {
    expect(pointInArea({ lat: 52.47, lng: 13.25 }, SQUARE)).toBe(true);
    expect(pointInArea({ lat: 52.52, lng: 13.25 }, SQUARE)).toBe(false);
    const multi: AreaShape = [
      ...SQUARE,
      [
        [13.5, 52.5],
        [13.6, 52.5],
        [13.6, 52.6],
        [13.5, 52.5],
      ],
    ];
    expect(pointInArea({ lat: 52.55, lng: 13.58 }, multi)).toBe(true);
  });

  it('insideRunM measures the distance to the area edge', () => {
    // From the centre heading east: 0.05° lng ≈ 3.39 km at 52.475°N.
    const run = insideRunM({ lat: 52.475, lng: 13.25 }, 90, SQUARE);
    expect(run).toBeGreaterThan(3300);
    expect(run).toBeLessThan(3400);
    expect(insideRunM({ lat: 52.6, lng: 13.25 }, 90, SQUARE)).toBe(0);
  });

  it('insideRunM crosses a narrow cut (a motorway through a forest)', () => {
    // Two halves of one forest split by a ~70 m gap at 13.25–13.251.
    const split: AreaShape = [
      [
        [13.2, 52.45],
        [13.25, 52.45],
        [13.25, 52.5],
        [13.2, 52.5],
        [13.2, 52.45],
      ],
      [
        [13.251, 52.45],
        [13.3, 52.45],
        [13.3, 52.5],
        [13.251, 52.5],
        [13.251, 52.45],
      ],
    ];
    const run = insideRunM({ lat: 52.475, lng: 13.22 }, 90, split);
    // 13.22 → 13.3 ≈ 5.4 km, not the 2 km to the cut.
    expect(run).toBeGreaterThan(5300);
  });

  it('interiorAnchor keeps a preferred point that is inside, else finds one', () => {
    const inside = { lat: 52.46, lng: 13.21 };
    expect(interiorAnchor(SQUARE, inside)).toBe(inside);
    const a = interiorAnchor(SQUARE, { lat: 53, lng: 14 });
    expect(pointInArea(a, SQUARE)).toBe(true);
  });
});

describe('detourPlans', () => {
  const start = { lat: 52.49, lng: 13.32 };
  const end = { lat: 52.45, lng: 13.32 };

  it('inserts a perpendicular point on the longest leg, left and right', () => {
    const plans = detourPlans(start, [], end, 10000);
    expect(plans).toHaveLength(2);
    const [l, r] = plans.map((p) => p.waypointsFor(1000));
    expect(l).toHaveLength(3);
    expect(l![0]).toEqual(start);
    expect(l![2]).toEqual(end);
    // Due-south leg → detours head east and west of it.
    expect(l![1]!.lng).not.toBeCloseTo(r![1]!.lng, 3);
    expect(l![1]!.lat).toBeCloseTo(52.47, 2);
  });

  it('moves an area via inside the area instead of adding a point', () => {
    const via = { lat: 52.475, lng: 13.25, area: SQUARE };
    const plans = detourPlans(start, [via], end, 8000);
    expect(plans).toHaveLength(3);
    for (const p of plans) {
      expect(p.maxOffsetM).toBeGreaterThan(0);
      const wps = p.waypointsFor(p.maxOffsetM);
      expect(wps).toHaveLength(3);
      expect(pointInArea(wps[1]!, SQUARE)).toBe(true);
    }
  });

  it('strips extra fields off the waypoints', () => {
    const via = { lat: 52.475, lng: 13.25, area: SQUARE, label: 'x' };
    const wps = detourPlans(start, [via], end, 8000)[0]!.waypointsFor(0);
    for (const w of wps) expect(Object.keys(w).sort()).toEqual(['lat', 'lng']);
  });
});

describe('solveOffset', () => {
  // A router whose distance grows linearly with offset: 10 km + 2.2 × offset.
  const linear = async (d: number) => ({
    distanceM: 10000 + 2.2 * d,
    value: d,
  });

  it('converges on the target within tolerance', async () => {
    const best = await solveOffset(linear, {
      baseM: 10000,
      targetM: 20000,
      maxOffsetM: 20000,
    });
    expect(Math.abs(best!.distanceM - 20000)).toBeLessThanOrEqual(600);
  });

  it('never spends more than maxEvals calls', async () => {
    const evaluate = jest.fn(async (d: number) => ({
      // Wildly non-linear: forces the bracketing path.
      distanceM: 10000 + (d > 3000 ? 30000 : d),
      value: d,
    }));
    await solveOffset(evaluate, {
      baseM: 10000,
      targetM: 20000,
      maxOffsetM: 20000,
      maxEvals: 4,
    });
    expect(evaluate.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('stops at the offset cap when even that is short', async () => {
    const evaluate = jest.fn(linear);
    const best = await solveOffset(evaluate, {
      baseM: 10000,
      targetM: 50000,
      maxOffsetM: 1000,
    });
    expect(best!.offsetM).toBe(1000);
    expect(evaluate.mock.calls.length).toBe(1);
  });

  it('backs off after a failed probe instead of giving up', async () => {
    const tried: number[] = [];
    const best = await solveOffset(
      async (d) => {
        tried.push(d);
        if (d > 2000) throw new Error('no routable point');
        return { distanceM: 10000 + 2.2 * d, value: d };
      },
      { baseM: 10000, targetM: 16000, maxOffsetM: 20000 },
    );
    expect(tried[1]).toBeLessThan(tried[0]!);
    expect(best).not.toBeNull();
  });

  it('returns null with no room to move', async () => {
    expect(
      await solveOffset(linear, { baseM: 1, targetM: 2, maxOffsetM: 0 }),
    ).toBeNull();
  });
});
